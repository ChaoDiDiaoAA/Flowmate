import { useEffect, useRef, useState } from 'react';
import type { AgentRunSnapshot, BusinessEventSnapshot, DocumentSnapshot, JobSnapshot, PromptTraceResult,
  RunSnapshot, RuntimeEvent, RuntimeState, RuntimeToolView, SessionSnapshot, ContextReference } from '@flowmate/contracts';
import type { EventViewState } from './event-state.ts';
import { Subagents } from './subagents.tsx';

const eventLabels: Record<RuntimeEvent['type'], string> = {
  run_created: 'Request accepted', run_started: 'Processing started', run_completed: 'Processing completed',
  run_failed: 'Processing failed', run_cancelled: 'Processing stopped', run_cancel_requested: 'Stop requested',
  run_usage_updated: 'Usage updated', tool_requested: 'Tool requested', tool_started: 'Tool started',
  tool_succeeded: 'Tool completed', tool_failed: 'Tool failed', tool_cancelled: 'Tool stopped', input_state_changed: 'Message delivery updated',
};
function toolLabel(name: string): string { return name.replaceAll('_', ' ').replace(/^./u, c => c.toUpperCase()); }
function utc(value: string): string { return new Date(value).toLocaleString(undefined, { timeZone: 'UTC' }) + ' UTC'; }
type Props = {
  hostEpoch: number; ready: boolean;
  sessions: readonly SessionSnapshot[]; selectedSessionId: number | null; jobs: readonly JobSnapshot[];
  documents: readonly DocumentSnapshot[]; currentRun: RunSnapshot | null; runtime: RuntimeState | null;
  view: EventViewState | null; snapshot: RunSnapshot | null; tools: readonly RuntimeToolView[];
  snapshotError: boolean; toolsError: boolean; toolsVerified: boolean;
  nextToolId: number | null; toolsLoading: boolean; onLoadMoreTools(): void;
  onClearObservation(): void;
  onObserve(runId: number, sessionId: number | null): void; onRefresh(): void;
  onSegment(after: number): void; onRetryPrefix(): void;
  onOpenInvoice(documentId: number): void; onOpenProcessing(jobId: number): void;
  onOpenEvaluationTrace(runId: number, sessionId: number | null): void;
  onOpenContextBasis(input: { sessionId: number; runId: number; context: ContextReference }): void;
};

export function ActivityPage(props: Props) {
  const [sessionId, setSessionId] = useState<number | null>(props.selectedSessionId);
  const [parentRunId, setParentRunId] = useState<number | null>(null);
  const [requests, setRequests] = useState<readonly AgentRunSnapshot[]>([]);
  const [nextRunId, setNextRunId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [businessError, setBusinessError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [business, setBusiness] = useState<readonly BusinessEventSnapshot[]>([]);
  const [nextBusinessId, setNextBusinessId] = useState<number | null>(null);
  const [trace, setTrace] = useState<PromptTraceResult | null>(null);
  const [traceError, setTraceError] = useState(false);
  const [toolDetail, setToolDetail] = useState<RuntimeToolView | null>(null);
  const generation = useRef(0);
  const businessGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const toolRequestGeneration = useRef(0);
  const businessReadPending = useRef(false);
  const [businessLoading, setBusinessLoading] = useState(false);
  async function reloadRequests(retain: boolean) {
    const sequence = ++generation.current;
    if (!retain) { setRequests([]); setNextRunId(null); }
    setRequestError(null);
    if (sessionId === null) { setLoading(false); return; }
    setLoading(true);
    try {
      const result = await window.flowmate.listSessionRuns({ sessionId, limit: 50 });
      if (sequence !== generation.current) return;
      if (result.ok) { setRequests(result.data.items); setNextRunId(result.data.nextBeforeRunId); }
      else setRequestError('Processing requests could not be loaded. Refresh activity to try again.');
    } catch { if (sequence === generation.current) setRequestError('Processing requests are unavailable.'); }
    finally { if (sequence === generation.current) setLoading(false); }
  }
  async function reloadBusiness(retain: boolean) {
    const sequence = ++businessGeneration.current;
    if (!retain) { setBusiness([]); setNextBusinessId(null); }
    setBusinessError(null);
    if (!filter) { businessReadPending.current = false; setBusinessLoading(false); return; }
    businessReadPending.current = true; setBusinessLoading(true);
    const [kind, id] = filter.split(':');
    try {
      const result = await window.flowmate.listActivity({ ...(kind === 'invoice' ? { documentId: Number(id) } : { jobId: Number(id) }), limit: 50 });
      if (sequence !== businessGeneration.current) return;
      if (result.ok) { setBusiness(result.data.items); setNextBusinessId(result.data.nextBeforeId); }
      else setBusinessError('Invoice activity could not be loaded. Refresh activity to try again.');
    } catch { if (sequence === businessGeneration.current) setBusinessError('Invoice activity is unavailable.'); }
    finally { if (sequence === businessGeneration.current) { businessReadPending.current = false; setBusinessLoading(false); } }
  }
  function refreshActivity() {
    void reloadRequests(true); void reloadBusiness(true); props.onRefresh();
  }
  useEffect(() => {
    void reloadRequests(false);
    return () => { generation.current++; };
  }, [sessionId]);
  useEffect(() => {
    const sequence = ++detailGeneration.current;
    toolRequestGeneration.current++;
    setTrace(null); setTraceError(false); setToolDetail(null);
    return () => { if (sequence === detailGeneration.current) detailGeneration.current++; };
  }, [props.view?.runId, props.view?.generation]);
  useEffect(() => {
    void reloadBusiness(false);
    return () => { businessGeneration.current++; };
  }, [filter]);
  async function loadMoreRequests() {
    if (sessionId === null || nextRunId === null || loading) return;
    const sequence = generation.current; setLoading(true);
    try {
      const result = await window.flowmate.listSessionRuns({ sessionId, beforeRunId: nextRunId, limit: 50 });
      if (sequence !== generation.current) return;
      if (result.ok) { setRequests(current => [...current, ...result.data.items]); setNextRunId(result.data.nextBeforeRunId); }
      else setRequestError('More processing requests could not be loaded.');
    } catch { if (sequence === generation.current) setRequestError('More processing requests are unavailable.'); }
    finally { if (sequence === generation.current) setLoading(false); }
  }
  async function loadMoreBusiness() {
    if (nextBusinessId === null || !filter || businessReadPending.current) return;
    businessReadPending.current = true; setBusinessLoading(true);
    const sequence = businessGeneration.current; const [kind, id] = filter.split(':');
    try {
      const result = await window.flowmate.listActivity({ ...(kind === 'invoice' ? { documentId: Number(id) } : { jobId: Number(id) }), beforeId: nextBusinessId, limit: 50 });
      if (sequence !== businessGeneration.current) return;
      if (result.ok) { setBusiness(current => [...current, ...result.data.items]); setNextBusinessId(result.data.nextBeforeId); }
      else setBusinessError('More invoice activity could not be loaded.');
    } catch { if (sequence === businessGeneration.current) setBusinessError('More invoice activity is unavailable.'); }
    finally { if (sequence === businessGeneration.current) { businessReadPending.current = false; setBusinessLoading(false); } }
  }
  async function loadTrace() {
    if (!props.view) return;
    const sequence = detailGeneration.current;
    try {
      const result = await window.flowmate.queryPromptTrace(props.view.runId);
      if (sequence !== detailGeneration.current) return;
      if (result.ok) { setTrace(result.data); setTraceError(false); } else setTraceError(true);
    } catch { if (sequence === detailGeneration.current) setTraceError(true); }
  }
  async function inspectTool(tool: RuntimeToolView) {
    const sequence = detailGeneration.current;
    const selection = ++toolRequestGeneration.current;
    setToolDetail(null);
    try {
      const result = await window.flowmate.queryRunToolCall({ runId: tool.runId, sessionId: tool.sessionId, toolCallId: tool.toolCallId });
      if (sequence !== detailGeneration.current || selection !== toolRequestGeneration.current) return;
      if (result.ok) setToolDetail(result.data); else setError('The tool activity could not be loaded.');
    } catch { if (sequence === detailGeneration.current && selection === toolRequestGeneration.current) setError('The tool activity is unavailable.'); }
  }
  const snapshot = props.snapshot;
  const agentFacts = snapshot?.output?.agent;
  const modelCalls = agentFacts !== null && typeof agentFacts === 'object' && 'modelCallCount' in agentFacts
    && typeof agentFacts.modelCallCount === 'number' ? agentFacts.modelCallCount : null;
  const budget = snapshot?.config.runtimeBudget as { maxToolCalls?: number; maxModelCalls?: number; toolTimeoutMs?: number } | undefined;
  const events = props.view ? [...props.view.events.values()].sort((a, b) => a.sequence - b.sequence) : [];
  return <section className="page-content activity-page" data-testid="activity-page">
    <div className="page-heading"><div><h1>Activity</h1><p>Review processing progress and saved invoice actions.</p></div>
      <button className="secondary-button" disabled={loading || businessLoading} onClick={refreshActivity}>Refresh activity</button></div>
    {[error, requestError, businessError].filter(Boolean).map(message => <p key={message} className="notice bad" role="alert">{message}</p>)}
    <section className="panel"><div className="panel-head"><h2>Processing requests</h2></div><div className="activity-controls">
      <label>Conversation<select aria-label="Conversation" value={sessionId ?? ''} onChange={e => { props.onClearObservation(); setParentRunId(null); setSessionId(e.target.value ? Number(e.target.value) : null); }}>
        <option value="">Choose a conversation</option>{props.sessions.map(s => <option key={s.sessionId} value={s.sessionId}>{s.title}</option>)}</select></label>
      <label>Request<select aria-label="Processing request" value={parentRunId ?? (props.view?.sessionId === sessionId ? props.view.runId : '')}
        onChange={e => { setParentRunId(e.target.value ? Number(e.target.value) : null); if (e.target.value && sessionId !== null) props.onObserve(Number(e.target.value), sessionId); else props.onClearObservation(); }}>
        <option value="">Choose a processing request</option>{requests.map(r => <option key={r.runId} value={r.runId}>
          {new Date(r.createdAt).toLocaleString()} · {r.status} · {r.input.text.slice(0, 120)}</option>)}</select></label>
      {props.currentRun && <button className="secondary-button" onClick={() => { setSessionId(props.currentRun!.sessionId); setParentRunId(props.currentRun!.kind === 'agent' ? props.currentRun!.runId : null); props.onObserve(props.currentRun!.runId, props.currentRun!.sessionId); }}>View latest request</button>}
      {nextRunId !== null && <button className="secondary-button" disabled={loading} onClick={() => void loadMoreRequests()}>Load earlier requests</button>}
      <button className="secondary-button" disabled={parentRunId === null && !props.view} onClick={() => {
        const runId = parentRunId ?? props.view?.runId;
        if (runId !== undefined && runId !== null) props.onOpenEvaluationTrace(runId, sessionId);
      }}>Open evaluation trace</button>
    </div>{loading && <p className="activity-note" role="status">Loading processing requests…</p>}</section>
    {parentRunId !== null && sessionId !== null && <Subagents key={`${props.hostEpoch}:${sessionId}:${parentRunId}`} parentRunId={parentRunId}
      parentSessionId={sessionId} hostEpoch={props.hostEpoch} ready={props.ready} refreshToken={`${props.view?.runId}:${props.view?.events.size}:${snapshot?.status}`}
      onObserve={props.onObserve} />}
    {props.view && <section className="panel" data-testid="processing-details"><div className="panel-head"><h2>Processing details</h2>
      <span role="status">{snapshot?.cancelRequestedAt && ['created', 'running'].includes(snapshot.status) ? 'Stopping' : snapshot?.status ?? 'Loading'}</span></div>
      {props.runtime?.blocked && <p className="notice bad" role="status">New requests are blocked. Saved processing details remain available to read.</p>}
      {props.snapshotError && <p className="notice bad" role="alert">Processing details could not be confirmed. Previously loaded details are retained. Refresh activity to try again.</p>}
      <div className="activity-facts"><dl>
        <div><dt>Tools called</dt><dd>{snapshot?.toolCallCount ?? '—'}{budget?.maxToolCalls === undefined ? '' : ` / ${budget.maxToolCalls}`}</dd></div>
        <div><dt>Model requests</dt><dd>{modelCalls ?? 'Not finalized'}{budget?.maxModelCalls === undefined ? '' : ` / ${budget.maxModelCalls}`}</dd></div>
        <div><dt>Elapsed</dt><dd>{snapshot?.durationMs === null || snapshot?.durationMs === undefined ? 'Not finalized' : `${(snapshot.durationMs / 1000).toFixed(2)} s`}</dd></div>
        <div><dt>Usage</dt><dd>{snapshot?.tokens.usageComplete ? 'Complete' : 'Incomplete'}</dd></div>
        <div><dt>Input / output tokens</dt><dd>{snapshot?.tokens.inputTokens ?? 'Unknown'} / {snapshot?.tokens.outputTokens ?? 'Unknown'}</dd></div>
        <div><dt>Stopped</dt><dd>{typeof snapshot?.cleanup.stopped === 'boolean' ? snapshot.cleanup.stopped ? 'Confirmed' : 'Unconfirmed' : 'Unknown'}</dd></div>
        <div><dt>Further stop observation</dt><dd>{typeof snapshot?.cleanup.lateObservationRequired === 'boolean' ? snapshot.cleanup.lateObservationRequired ? 'Required' : 'Not required' : 'Unknown'}</dd></div>
      </dl>{snapshot?.error && <p role="status">Processing ended with: {snapshot.error.code}</p>}
      {snapshot?.jobId && <button className="text-button" onClick={() => props.onOpenProcessing(snapshot.jobId!)}>Open processing results</button>}</div>
      <div className="panel-head"><h3>Timeline</h3><span>{!props.view.context ? 'History not yet verified' : props.view.context.coverage === 'from-created' ? 'Recorded from acceptance' : props.view.context.coverage === 'partial' ? 'Partial recorded history' : 'No recorded events'}</span></div>
      {props.view.context?.availableRange && <p className="activity-note" role="status">Available recorded activity: {props.view.context.availableRange.fromSequence} to {props.view.context.availableRange.toSequence}.</p>}
      {props.view.needsRefresh && <p className="activity-note" role="status">Catching up with recorded activity…</p>}
      {props.view.error && <div className="notice bad" role="alert">{props.view.error.code === 'event_gap' ? 'Some recorded activity is missing. The verified position has been retained.' : props.view.error.message}
        <div className="button-row"><button className="secondary-button" onClick={props.onRetryPrefix}>{props.view.error.code === 'event_cursor_invalid' ? 'Reload recorded history' : 'Check recorded prefix again'}</button>
          {props.view.gap && <button className="secondary-button" onClick={() => props.onSegment(props.view!.gap!.continueAfterSequence)}>View available activity after the gap</button>}</div></div>}
      {props.view.gap && <p className="activity-note" role="status">Missing recorded activity: {props.view.gap.fromSequence} to {props.view.gap.toSequence}. The continuous position has been retained.</p>}
      {events.length === 0 ? <p className="activity-note" role="status">{props.view.context?.coverage === 'none' ? 'No runtime events were recorded for this request. Saved messages and results remain available.' : props.view.error ? 'Recorded activity has not been verified. Refresh to try again.' : 'Loading recorded activity…'}</p>
        : <ol className="activity-timeline">{events.map(e => <li key={e.eventId}><span className="activity-sequence">{e.sequence}</span><div><strong>{eventLabels[e.type]}</strong>
          <time dateTime={e.occurredAt}>{utc(e.occurredAt)}</time>{'toolName' in e.payload && <span>{toolLabel(e.payload.toolName)}</span>}
          {'origin' in e.payload && e.payload.origin === 'recovery' && <span>Recorded during recovery</span>}
          {'committedCandidateId' in e.payload && e.payload.committedCandidateId !== null && snapshot?.jobId && <button className="text-button" onClick={() => props.onOpenProcessing(snapshot.jobId!)}>View saved result</button>}
        </div></li>)}</ol>}
      {props.view.displayAfterSequence !== null && <div className="activity-note"><p>Showing an available segment. The continuous position is still {props.view.cursor.lastPersistedSequence}.</p>
        <button className="secondary-button" onClick={props.onRetryPrefix}>Check recorded prefix again</button></div>}
      <div className="panel-head"><h3>Tool activity</h3></div><div className="activity-tools">
        {props.toolsError && <p className="notice bad" role="alert">Tool activity could not be confirmed. Previously loaded tools are retained. Refresh activity to try again.</p>}
        {props.tools.length === 0 ? <p>{props.toolsVerified ? 'No tools recorded.' : 'Tool activity has not yet been verified.'}</p> : props.tools.map(t =>
        <button className="route-row" key={t.toolCallId} onClick={() => void inspectTool(t)}><strong>{toolLabel(t.toolName)}</strong><span>{t.status} · {t.deliveryState.replaceAll('_', ' ')}</span></button>)}
        {props.nextToolId !== null && <button className="secondary-button" disabled={props.toolsLoading} onClick={props.onLoadMoreTools}>Load earlier tool activity</button>}
        {toolDetail && <dl className="activity-tool-detail"><div><dt>Tool</dt><dd>{toolLabel(toolDetail.toolName)}</dd></div><div><dt>State</dt><dd>{toolDetail.status}</dd></div>
          <div><dt>Stopped</dt><dd>{toolDetail.stopped === null ? 'Unknown' : toolDetail.stopped ? 'Confirmed' : 'Unconfirmed'}</dd></div>
          <div><dt>Delivery</dt><dd>{toolDetail.deliveryState.replaceAll('_', ' ')}</dd></div><div><dt>Form update</dt><dd>{toolDetail.formApplicationOutcome ?? 'Not applicable'}</dd></div>
          {toolDetail.committedCandidateId !== null && snapshot?.jobId && <div><dt>Saved result</dt><dd><button className="text-button" onClick={() => props.onOpenProcessing(snapshot.jobId!)}>View saved result</button></dd></div>}
          {toolDetail.errorCode && <div><dt>Issue</dt><dd>{toolDetail.errorCode}</dd></div>}
          {toolDetail.context && <div><dt>Context</dt><dd><button className="text-button" onClick={() => props.onOpenContextBasis({ sessionId: toolDetail.sessionId,
            runId: toolDetail.runId, context: toolDetail.context! })}>View original context basis</button></dd></div>}</dl>}</div>
      <details className="activity-diagnostics"><summary onClick={() => void loadTrace()}>Model request diagnostics</summary>
        <p>This diagnostic buffer belongs to the current process and is separate from saved activity.</p>
        {traceError ? <p role="alert">Model request diagnostics are unavailable.</p> : trace && <><p>{trace.availability === 'evicted' ? 'These diagnostics were evicted from the process buffer.' : trace.availability === 'process-exited' ? 'The process that collected these diagnostics has exited.' : trace.availability.replaceAll('-', ' ')} · {trace.calls.length} request(s) · {trace.droppedCalls ?? 'Unknown'} evicted request(s)</p>
          {trace.calls.map(call => <div key={call.callSequence}><strong>Request {call.callSequence} · {call.state}</strong><p>{call.entries.map(entry => entry.event).join(' → ')} · {call.droppedEntries} evicted detail(s)</p></div>)}</>}
      </details>
    </section>}
    <section className="panel"><div className="panel-head"><h2>Invoice actions</h2></div><div className="activity-controls"><label>Invoice or processing record
      <select aria-label="Invoice or processing record" value={filter} onChange={e => setFilter(e.target.value)}><option value="">Choose invoice activity</option>
        {props.documents.map(d => <option key={`invoice:${d.documentRef.id}`} value={`invoice:${d.documentRef.id}`}>{d.displayName}</option>)}
        {props.jobs.map(j => <option key={`processing:${j.jobId}`} value={`processing:${j.jobId}`}>Processing · {j.goal}</option>)}</select></label></div>
      {business.length === 0 ? <p className="activity-note">Select an invoice or processing record to see its saved actions.</p> : <ol className="activity-timeline">{business.map(action =>
        <li key={action.id}><div><strong>{action.type === 'candidate_exported' ? 'Managed export registered' : action.type.replaceAll('_', ' ')}</strong><time dateTime={action.occurredAt}>{utc(action.occurredAt)}</time>
          {action.documentId && <button className="text-button" onClick={() => props.onOpenInvoice(action.documentId!)}>View invoice</button>}
          {action.jobId && <button className="text-button" onClick={() => props.onOpenProcessing(action.jobId!)}>View processing</button>}</div></li>)}</ol>}
      {nextBusinessId !== null && <button className="secondary-button" disabled={businessLoading} onClick={() => void loadMoreBusiness()}>Load earlier actions</button>}
    </section>
  </section>;
}
