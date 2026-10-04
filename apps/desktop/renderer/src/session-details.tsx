import { useEffect, useRef, useState } from 'react';
import type { CandidateJobDetail, ContextReference, ContextSnapshotDetail, ContextSnapshotsPage,
  ContextRequestsPage, Result, SessionRunsPage } from '@flowmate/contracts';
import { acceptContextRead, beginContextRead, contextReadLease, createContextRead, failContextRead, finishContextRead,
  matchesContextRead, sameContextIdentity, type ContextIdentity } from './context-state.ts';
import { SessionHistory } from './session-history.tsx';
import type { ForkSessionRequest, ForkSessionResult } from '@flowmate/contracts';

export type ContextBasis = Readonly<{ sessionId: number; runId: number; context: ContextReference }>;
type Props = { sessionId: number; hostEpoch: number; hostReady: boolean; navigationToken: number;
  initialForkRequest: ForkSessionRequest | null; onForkRequest(request: ForkSessionRequest | null): void;
  historySelectionToken: number; captureHistorySelection(): () => boolean;
  initialRunId?: number | null;
  initialSnapshotId?: number | null;
  onHistoryBranch(sessionId: number): void;
  onHistoryFork(result: ForkSessionResult, current: () => boolean): Promise<boolean>;
  onOpenOwner(sessionId: number, runId: number | null, context?: ContextReference, snapshotId?: number): void;
  basis: ContextBasis | null; refreshToken: number; sourceError: string | null; onRunChange(runId: number | null): void; onClose(): void;
  onOpenCandidateBasis(candidate: CandidateJobDetail['candidate']): void };

function useRead<T>(identity: ContextIdentity, scope = '') {
  const state = useRef(createContextRead<T>(identity)), scopeRef = useRef(scope), sequence = useRef(0), alive = useRef(true);
  const [, render] = useState(0);
  if (!sameContextIdentity(state.current.identity, identity) || scopeRef.current !== scope) {
    state.current = createContextRead<T>(identity); scopeRef.current = scope;
  }
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function read(key: string, query: () => Promise<Result<T>>, verify: (data: T) => boolean,
    merge?: (previous: T | null, next: T) => T): Promise<T | null> {
    state.current = beginContextRead(state.current, ++sequence.current, key);
    const lease = contextReadLease(state.current); render(value => value + 1);
    try {
      const result = await query();
      if (!alive.current || !matchesContextRead(state.current, lease)) return null;
      if (!result.ok) state.current = failContextRead(state.current, lease, result.error.message);
      else if (!verify(result.data)) state.current = failContextRead(state.current, lease, 'The saved context could not be verified.');
      else { state.current = acceptContextRead(state.current, lease, merge ? merge(state.current.data, result.data) : result.data); return result.data; }
      return null;
    } catch {
      if (alive.current) state.current = failContextRead(state.current, lease, 'Context could not be loaded. Refresh to try again.');
      return null;
    } finally {
      if (alive.current && matchesContextRead(state.current, lease)) {
        state.current = finishContextRead(state.current, lease); render(value => value + 1);
      }
    }
  }
  return { state: state.current, read };
}
function ReadIssue({ error, pending }: { error: string | null; pending: boolean }) {
  return <>{error && <p className="notice bad" role="alert">{error}</p>}{pending && <p role="status">Loading context…</p>}</>;
}
export function ContextRequestFacts({ request, onSnapshot, onRequestBasis }: { request: ContextRequestsPage['items'][number];
  onSnapshot(runId: number, snapshotId: number): void; onRequestBasis(runId: number, context: ContextReference): void }) {
  const binding = request.binding;
  return <article className="context-request" data-testid="context-request" data-request-sequence={binding.requestSequence}>
    <h4>Request {binding.requestSequence}</h4><dl className="activity-facts">
      <div><dt>Request context observed</dt><dd>{request.boundAt} · {request.api}</dd></div>
      <div><dt>Payload</dt><dd>{request.sdkPayload === null ? 'Not observed' : request.sdkPayload.inclusion === 'confirmed'
        ? 'Payload observed' : `Evidence unavailable · ${request.sdkPayload.reason}`}</dd></div>
      <div><dt>Transport</dt><dd>{request.transport === 'not-observable' ? 'Not observed' : request.attempts.length ? 'Recorded attempts' : 'Not observed'}</dd></div>
    </dl>
    <div className="context-bindings"><span>Primary basis: </span><button className="text-button" onClick={() => onRequestBasis(binding.runId,
      { snapshotId: binding.snapshotId, requestSequence: binding.requestSequence })}>Snapshot {binding.snapshotId}</button>
      {binding.includedBindings.map((input, index) => <p key={`input-${index}`}>Input {input.inputId ?? 'legacy'} · Entry {input.nativeEntryId} · Run {input.originRunId ?? 'legacy'} ·
        {input.snapshotId === null || input.originRunId === null ? ' Legacy basis unavailable' : <button className="text-button" onClick={() => onSnapshot(input.originRunId!, input.snapshotId!)}>Snapshot {input.snapshotId}</button>}</p>)}
      {binding.includedToolResults.map((tool, index) => <p key={`tool-${index}`}>Tool result {tool.nativeToolCallId} · Original Run {tool.originRunId ?? 'legacy'} ·
        {tool.context === null || tool.originRunId === null ? ' Legacy basis unavailable' : <button className="text-button" onClick={() => onRequestBasis(tool.originRunId!, tool.context!)}>Snapshot {tool.context.snapshotId} / Request {tool.context.requestSequence}</button>}</p>)}
      {binding.includedNativeContexts === null ? <p>Native context sources were not collected.</p> : binding.includedNativeContexts.map(source =>
        <p key={source.nativeEntryId}>Native context {source.entryType} · Entry {source.nativeEntryId} · Source Session {source.originSessionId}</p>)}
    </div>
    {request.attempts.map(attempt => <dl key={attempt.attempt} className="activity-facts"><div><dt>Attempt {attempt.attempt} prepared</dt><dd>{attempt.preparedAt}</dd></div>
      <div><dt>Transport call</dt><dd>{attempt.enteredAt ? `Transport call observed · ${attempt.enteredAt}` : 'Not observed'}</dd></div>
      <div><dt>Response</dt><dd>{attempt.responseAt ? `Response observed · ${attempt.responseStatus} · ${attempt.responseAt}` : 'Not observed'}</dd></div>
      <div><dt>Wire inclusion</dt><dd>{attempt.wireInclusion === 'confirmed' ? 'Confirmed' : `Evidence unavailable · ${attempt.wireReason}`}</dd></div>
      <div><dt>Native request ID</dt><dd>{attempt.nativeRequestId ?? 'Not observed'}</dd></div>
      {attempt.transportErrorCode && <div><dt>Issue</dt><dd>{attempt.transportErrorCode}</dd></div>}</dl>)}
  </article>;
}

export function ContextCollectionNotice({ page }: { page: ContextRequestsPage }) {
  return <>{page.collection === 'not-collected' && <p>Evidence unavailable · Legacy request evidence was not collected.</p>}
    {page.collection === 'collected' && page.items.length === 0 && <p>Not observed · No request bindings recorded.</p>}</>;
}

export function ContextSnapshotFacts({ detail, pendingCandidate, canQueryCandidate, onInspectCandidate }: {
  detail: ContextSnapshotDetail; pendingCandidate: boolean; canQueryCandidate: boolean; onInspectCandidate(): void;
}) {
  const { snapshot: saved, input } = detail, projection = saved.json.modelProjection;
  return <section data-testid="context-snapshot-detail" className="context-snapshot-detail"><h4>Snapshot {saved.id} · Saved</h4>
    <p>{saved.json.text}</p><dl className="activity-facts"><div><dt>Input {input.inputId}</dt><dd>{input.status === 'consumed' ? 'Input consumed' : `Not consumed · ${input.status}`}</dd></div>
      <div><dt>Processing</dt><dd>{input.processingStatus}</dd></div><div><dt>Native entry</dt><dd>{input.nativeEntryId ?? 'Not observed'}</dd></div>
      <div><dt>Document</dt><dd>{saved.json.workspaceContext?.documentRef ? `${saved.json.workspaceContext.documentRef.id} / ${saved.json.workspaceContext.documentRef.version}` : 'No business material'}</dd></div>
      <div><dt>Goal</dt><dd>{saved.json.goalMode} · {projection.taskGoal ?? 'No task goal'}</dd></div></dl>
    {input.error && <p role="alert">{input.error.code} · {input.error.category} · {input.error.retryable ? 'Retryable' : 'Not retryable'}</p>}
    {saved.json.goalMode === 'fill-form' && <p>Fill reference · Saved candidate {projection.candidate?.id} / sequence {projection.candidate?.sequence}. The full form payload is not copied into this snapshot.</p>}
    {projection.candidate && <div><h4>Candidate {projection.candidate.id} · {projection.candidate.origin} · {projection.candidate.statusAtSelection}</h4>
      {projection.candidate.values.map(value => <p key={value.fieldPath}>{value.fieldPath} · {value.value.normalized ?? value.value.raw ?? '—'} · {value.value.state}</p>)}
      <button className="text-button" disabled={pendingCandidate || !canQueryCandidate} onClick={onInspectCandidate}>View original candidate</button></div>}
    {projection.fragments.map(fragment => <article key={`${fragment.artifactId}:${fragment.page}:${fragment.blockId}`} className="context-fragment"><h4>Page {fragment.page} · Block {fragment.blockId}</h4>
      <p>Document {fragment.documentRef.id} / {fragment.documentRef.version} · Artifact {fragment.artifactId} · {fragment.reasons.join(', ')}</p>
      <p>{fragment.includedBytes} / {fragment.originalBytes} bytes · {fragment.truncated ? 'Truncated' : 'Complete block'}</p>
      {fragment.windows.map(window => <div key={`${window.start}:${window.end}`}><small>Window {window.start}–{window.end}</small><pre>{window.text}</pre></div>)}
      {fragment.sources.map((source, index) => <p key={index}>Source {source.page} / {source.blockId ?? 'page'} · {source.quote ?? 'No quote'}</p>)}</article>)}
    {projection.issues.length > 0 && <><h4>Issues and conflicts</h4><ul>{projection.issues.map((issue, index) => <li key={index}>{issue.severity} · {issue.message} · {issue.fieldPaths.join(', ')}</li>)}</ul></>}
    {projection.gaps.length > 0 && <><h4>Omissions</h4><ul>{projection.gaps.map((gap, index) => <li key={index}>{gap.code} · {gap.omittedCount} · {gap.fieldPaths.join(', ')}</li>)}</ul></>}
  </section>;
}

export function SessionDetails(props: Props) {
  const [runId, setRunId] = useState<number | null>(props.basis?.runId ?? props.initialRunId ?? null);
  const [snapshotId, setSnapshotId] = useState<number | null>(props.basis?.context.snapshotId ?? props.initialSnapshotId ?? null);
  const [requestBasis, setRequestBasis] = useState<Pick<ContextBasis, 'runId' | 'context'> | null>(props.basis);
  const token = useRef(0), identityKey = `${props.hostEpoch}:${props.sessionId}:${props.navigationToken}:${runId}`;
  const priorIdentity = useRef('');
  if (priorIdentity.current !== identityKey) { priorIdentity.current = identityKey; token.current++; }
  const identity: ContextIdentity = { hostEpoch: props.hostEpoch, sessionId: props.sessionId, runId, selectionToken: token.current };
  const runs = useRead<SessionRunsPage>({ ...identity, runId: null, selectionToken: props.navigationToken });
  const snapshots = useRead<ContextSnapshotsPage>(identity), detail = useRead<ContextSnapshotDetail>(identity, String(snapshotId));
  const requests = useRead<ContextRequestsPage>(identity), candidate = useRead<CandidateJobDetail>(identity, String(snapshotId));
  const refreshBusy = useRef<string | null>(null), refreshPending = useRef(false), lastRefresh = useRef(0);
  const refreshIdentity = `${identityKey}:${snapshotId}`;
  const closeButton = useRef<HTMLButtonElement | null>(null), latest = useRef(refreshIdentity);
  const dialog = useRef<HTMLElement | null>(null);
  const ownerRequest = useRef(0), ownerAlive = useRef(true);
  const [ownerError, setOwnerError] = useState<string | null>(null);
  useEffect(() => { ownerAlive.current = true; return () => { ownerAlive.current = false; ownerRequest.current++; }; }, []);
  latest.current = refreshIdentity;
  useEffect(() => { const previous = document.activeElement; closeButton.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); }; }, []);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); props.onClose(); }
      if (event.key === 'Tab' && !dialog.current?.contains(document.activeElement)) { event.preventDefault(); closeButton.current?.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [props.onClose]);
  function selectRun(id: number) { setRunId(id); setSnapshotId(null); setRequestBasis(null); props.onRunChange(id); }
  function selectSnapshot(originRunId: number, id: number) {
    setRunId(originRunId); setSnapshotId(id); setRequestBasis(null); props.onRunChange(originRunId);
  }
  function selectRequestBasis(originRunId: number, context: ContextReference) {
    setRunId(originRunId); setSnapshotId(context.snapshotId); setRequestBasis({ runId: originRunId, context }); props.onRunChange(originRunId);
  }
  async function openOwner(sessionId: number | null, originRunId: number | null, context?: ContextReference, snapshotId?: number) {
    const captured = latest.current, request = ++ownerRequest.current;
    const current = () => ownerAlive.current && latest.current === captured && ownerRequest.current === request;
    setOwnerError(null);
    try {
      if (originRunId === null) { if (sessionId !== null) props.onOpenOwner(sessionId, null); return; }
      const result = await window.flowmate.queryRun(originRunId);
      if (!current()) return;
      if (!result.ok || result.data.kind !== 'agent' || result.data.runId !== originRunId || !Number.isSafeInteger(result.data.sessionId)
        || typeof result.data.sessionId !== 'number' || result.data.sessionId < 1 || sessionId !== null && result.data.sessionId !== sessionId) throw new Error('Unverified owner');
      props.onOpenOwner(result.data.sessionId, originRunId, context, snapshotId);
    } catch { if (current()) setOwnerError('The original context owner could not be verified.'); }
  }
  async function loadRuns(beforeRunId?: number) {
    const page = await runs.read(`runs:${beforeRunId ?? 'first'}:20`, () => window.flowmate.listSessionRuns({ sessionId: props.sessionId, limit: 20,
      ...(beforeRunId === undefined ? {} : { beforeRunId }) }), value => value.items.every(item => item.sessionId === props.sessionId && (beforeRunId === undefined || item.runId < beforeRunId)),
      beforeRunId === undefined ? undefined : (previous, next) => ({ ...next, items: [...(previous?.items ?? []), ...next.items] }));
    if (page && runId === null && page.items[0]) selectRun(page.items[0].runId);
  }
  async function loadSnapshots(beforeId?: number) {
    if (runId === null) return;
    const page = await snapshots.read(`snapshots:${runId}:${beforeId ?? 'first'}:20`, () => window.flowmate.listContextSnapshots({ sessionId: props.sessionId, runId,
      limit: 20, ...(beforeId === undefined ? {} : { beforeId }) }), value => value.sessionId === props.sessionId && value.runId === runId
        && value.items.every(item => item.runId === runId && item.sessionId === props.sessionId && (beforeId === undefined || item.id < beforeId)),
      beforeId === undefined ? undefined : (previous, next) => ({ ...next, items: [...(previous?.items ?? []), ...next.items] }));
    if (page && page.items[0]) {
      const initialId = page.items[0].id;
      setSnapshotId(current => current ?? initialId);
    }
  }
  async function loadRequests(beforeRequestSequence?: number) {
    if (runId === null) return;
    return requests.read(`requests:${runId}:${beforeRequestSequence ?? 'first'}:20`, () => window.flowmate.listContextRequests({ sessionId: props.sessionId, runId,
      limit: 20, ...(beforeRequestSequence === undefined ? {} : { beforeRequestSequence }) }), value => value.sessionId === props.sessionId && value.runId === runId
        && value.items.every(item => item.binding.sessionId === props.sessionId && item.binding.runId === runId
          && (beforeRequestSequence === undefined || item.binding.requestSequence < beforeRequestSequence)),
      beforeRequestSequence === undefined ? undefined : (previous, next) => ({ ...next, items: [...(previous?.items ?? []), ...next.items] }));
  }
  async function loadDetail() {
    if (runId === null || snapshotId === null) return;
    await detail.read(`detail:${runId}:${snapshotId}`, () => window.flowmate.queryContextSnapshot({ sessionId: props.sessionId, runId, snapshotId }),
      value => value.snapshot.id === snapshotId && value.snapshot.sessionId === props.sessionId && value.snapshot.runId === runId
        && value.input.sessionId === props.sessionId && value.input.runId === runId);
  }
  async function refresh() {
    if (!props.hostReady || runId === null) return;
    const captured = refreshIdentity;
    if (refreshBusy.current === captured) { refreshPending.current = true; return; }
    refreshBusy.current = captured; refreshPending.current = false;
    try { await Promise.all([loadSnapshots(), loadRequests(), loadDetail()]); }
    finally { if (latest.current === captured && refreshBusy.current === captured) {
      refreshBusy.current = null; const again = refreshPending.current; refreshPending.current = false; if (again) void refresh();
    } }
  }
  useEffect(() => { if (props.hostReady) void loadRuns(); }, [props.hostEpoch, props.sessionId, props.navigationToken, props.hostReady]);
  useEffect(() => { if (props.hostReady && runId !== null) { void loadSnapshots(); void loadRequests(); } }, [identityKey, props.hostReady]);
  useEffect(() => { if (props.hostReady) void loadDetail(); }, [identityKey, snapshotId, props.hostReady]);
  useEffect(() => { if (props.refreshToken !== lastRefresh.current) { lastRefresh.current = props.refreshToken; void refresh(); } }, [props.refreshToken]);
  useEffect(() => {
    const wanted = requestBasis?.runId === runId ? requestBasis.context.requestSequence : null;
    const page = requests.state.data;
    if (wanted && page && !requests.state.pending && !requests.state.error && !page.items.some(item => item.binding.requestSequence === wanted)
      && page.nextBeforeRequestSequence !== null) void loadRequests(page.nextBeforeRequestSequence);
    else if (wanted && page?.items.some(item => item.binding.requestSequence === wanted))
      document.getElementById(`context-request-${props.navigationToken}-${wanted}`)?.scrollIntoView({ block: 'nearest' });
  }, [requests.state.data, requests.state.pending, requestBasis, runId, props.navigationToken]);
  const saved = detail.state.data?.snapshot, projection = saved?.json.modelProjection;
  async function inspectCandidate() {
    if (!saved?.jobId || !projection?.candidate) return;
    await candidate.read(`candidate:${saved.jobId}:${projection.candidate.id}:${projection.candidate.sequence}`,
      () => window.flowmate.queryJobCandidate({ jobId: saved.jobId!, candidateId: projection.candidate!.id }), value => value.candidate.jobId === saved.jobId
        && value.candidate.candidateId === projection.candidate!.id && value.candidate.sequence === projection.candidate!.sequence);
  }
  return <div className="context-dialog-backdrop"><section ref={dialog} className="panel session-details" role="dialog" aria-modal="true" aria-label="Session details"
    onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); props.onClose(); }
      if (event.key === 'Tab') {
        const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex="0"]')]
          .filter(element => element.getClientRects().length > 0);
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
    <div className="panel-head"><div><h2>Session details</h2><p>Session {props.sessionId} · Recorded facts</p></div>
      <button ref={closeButton} className="secondary-button" onClick={props.onClose}>Close details</button></div>
    <SessionHistory sessionId={props.sessionId} hostEpoch={props.hostEpoch} navigationToken={props.navigationToken} hostReady={props.hostReady}
      initialForkRequest={props.initialForkRequest} onForkRequest={props.onForkRequest} captureSelection={props.captureHistorySelection} selectionToken={props.historySelectionToken}
      onBranch={props.onHistoryBranch} onFork={props.onHistoryFork} onOwner={(sessionId, runId) => void openOwner(sessionId, runId)} />
    {ownerError && <p role="alert">{ownerError}</p>}
    <h3>Context</h3><p className="config-note">Saved context and request evidence are separate from the model's answer.</p>
    {props.sourceError && <p className="notice bad" role="alert">{props.sourceError}</p>}
    {!props.hostReady && <p className="notice bad" role="alert">The Host is unavailable. Reconnect to read saved context.</p>}
    <ReadIssue error={runs.state.error} pending={runs.state.pending} />
    <div className="context-controls"><label>Historical Run<select aria-label="Historical Run" value={runId ?? ''} onChange={event => selectRun(Number(event.target.value))}>
      {runId === null && <option value="">Choose a Run</option>}{runId !== null && !runs.state.data?.items.some(item => item.runId === runId)
        && <option value={runId}>Run {runId}</option>}{runs.state.data?.items.map(run => <option key={run.runId} value={run.runId}>Run {run.runId} · {run.status}</option>)}</select></label>
      <button className="secondary-button" disabled={!props.hostReady || runId === null} onClick={() => void refresh()}>Refresh</button>
      {runs.state.data?.nextBeforeRunId != null && <button className="text-button" disabled={runs.state.pending} onClick={() => void loadRuns(runs.state.data!.nextBeforeRunId!)}>Earlier Runs</button>}</div>
    {runs.state.data?.items.length === 0 && <p>No Runs recorded.</p>}
    <ReadIssue error={snapshots.state.error} pending={snapshots.state.pending} />
    <div className="context-snapshots">{snapshots.state.data?.items.map(snapshot => <button key={snapshot.id} className="secondary-button" aria-pressed={snapshotId === snapshot.id}
      onClick={() => selectSnapshot(snapshot.runId, snapshot.id)}>Snapshot {snapshot.id} · {snapshot.mode}</button>)}</div>
    {snapshots.state.data?.items.length === 0 && <p>No snapshots recorded for this Run.</p>}
    {snapshots.state.data?.nextBeforeId != null && <button className="text-button" disabled={snapshots.state.pending} onClick={() => void loadSnapshots(snapshots.state.data!.nextBeforeId!)}>Earlier snapshots</button>}
    <ReadIssue error={detail.state.error} pending={detail.state.pending} />
    {detail.state.data && <ContextSnapshotFacts detail={detail.state.data} pendingCandidate={candidate.state.pending}
      canQueryCandidate={props.hostReady} onInspectCandidate={() => void inspectCandidate()} />}
    <ReadIssue error={candidate.state.error} pending={candidate.state.pending} />
    {candidate.state.data && <section className="context-candidate"><h4>Original candidate {candidate.state.data.candidate.candidateId}</h4>
      <p>{candidate.state.data.candidate.origin ?? 'model'} · {candidate.state.data.candidate.status}</p>
      {Object.entries(candidate.state.data.candidate.fields).map(([name, value]) => <p key={name}>{name} · {value.normalized ?? value.raw ?? '—'}</p>)}
      <button className="text-button" onClick={() => props.onOpenCandidateBasis(candidate.state.data!.candidate)}>View original context basis</button></section>}
    <h3>Requests</h3><p className="config-note">Recorded for this Run. Each request lists its own input and tool result bases.</p>
    <ReadIssue error={requests.state.error} pending={requests.state.pending} />
    {requests.state.data && <ContextCollectionNotice page={requests.state.data} />}
    {requests.state.data?.items.map(request => <div id={`context-request-${props.navigationToken}-${request.binding.requestSequence}`} key={request.binding.requestSequence}>
      <ContextRequestFacts request={request} onSnapshot={(originRunId, id) => {
        if (originRunId === runId) selectSnapshot(originRunId, id); else void openOwner(null, originRunId, undefined, id);
      }} onRequestBasis={(originRunId, context) => {
        if (originRunId === runId) selectRequestBasis(originRunId, context); else void openOwner(null, originRunId, context);
      }} /></div>)}
    {requests.state.data?.nextBeforeRequestSequence != null && <button className="text-button" disabled={requests.state.pending} onClick={() => void loadRequests(requests.state.data!.nextBeforeRequestSequence!)}>Earlier requests</button>}
  </section></div>;
}
