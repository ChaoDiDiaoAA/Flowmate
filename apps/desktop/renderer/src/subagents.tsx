import { useEffect, useRef, useState } from 'react';
import type { SubagentDetail, SubagentSummary, TokenColumns } from '@flowmate/contracts';
import { SessionHistory } from './session-history.tsx';

type Props = { parentRunId: number; parentSessionId: number; hostEpoch: number; ready: boolean;
  refreshToken: string; compact?: boolean; busy?: boolean; onObserve(runId: number, sessionId: number): void };

export function Subagents(props: Props) {
  const [items, setItems] = useState<readonly SubagentSummary[]>([]), [next, setNext] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null), [detail, setDetail] = useState<SubagentDetail | null>(null);
  const [loading, setLoading] = useState(false), [detailLoading, setDetailLoading] = useState(false), [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null), [detailError, setDetailError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [history, setHistory] = useState(false);
  const [summaries, setSummaries] = useState<Record<number, SubagentDetail>>({});
  const [totals, setTotals] = useState<TokenColumns | null>(null);
  const alive = useRef(true), ready = useRef(props.ready), selection = useRef<number | null>(null);
  const reads = useRef({ list: 0, detail: 0, stop: 0 }); ready.current = props.ready;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function readDetail(childRunId: number) {
    const token = ++reads.current.detail;
    const current = () => alive.current && ready.current && reads.current.detail === token && selection.current === childRunId;
    if (!ready.current) return;
    setDetailLoading(true); setDetailError(null);
    try {
      const result = await window.flowmate.querySubagent({ parentRunId: props.parentRunId, parentSessionId: props.parentSessionId, childRunId });
      if (!current()) return;
      if (result.ok) setDetail(result.data); else setDetailError(`Saved child facts are unavailable (${result.error.code}). Refresh to try again.`);
    } catch { if (current()) setDetailError('Saved child facts are unavailable. Refresh to try again.'); }
    finally { if (current()) setDetailLoading(false); }
  }
  async function load(beforeRunId?: number) {
    if (!ready.current) return;
    const token = ++reads.current.list, current = () => alive.current && ready.current && reads.current.list === token;
    setLoading(true); setError(null);
    try {
      const result = await window.flowmate.listSubagents({ parentRunId: props.parentRunId, parentSessionId: props.parentSessionId,
        ...(beforeRunId === undefined ? {} : { beforeRunId }), limit: 20 });
      if (!current()) return;
      if (result.ok) { setItems(prior => beforeRunId === undefined ? result.data.items : [...prior, ...result.data.items]); setNext(result.data.nextBeforeRunId); setTotals(result.data.totals);
        if (props.compact) {
          const details = await Promise.all(result.data.items.map(child => window.flowmate.querySubagent({ parentRunId: props.parentRunId,
            parentSessionId: props.parentSessionId, childRunId: child.childRunId }).catch(() => null)));
          if (current()) setSummaries(Object.fromEntries(details.flatMap((detail, index) => detail?.ok
            && detail.data.childRunId === result.data.items[index]?.childRunId ? [[detail.data.childRunId, detail.data]] : [])));
        }
      }
      else setError(`Subagents could not be loaded (${result.error.code}). Saved details are retained.`);
    } catch { if (current()) setError('Subagents are unavailable. Refresh to try again.'); }
    finally { if (current()) setLoading(false); }
  }
  function refresh() { void load(); if (selection.current !== null) void readDetail(selection.current); }
  useEffect(() => { if (props.ready) refresh(); else { reads.current.list++; reads.current.detail++; reads.current.stop++; setLoading(false); setDetailLoading(false); setStopping(false); } },
    [props.ready, props.refreshToken]);
  useEffect(() => { if (!props.compact || !props.busy || !props.ready) return;
    const timer = setInterval(refresh, 1000); return () => clearInterval(timer);
  }, [props.compact, props.busy, props.ready]);
  function select(childRunId: number) {
    selection.current = childRunId; reads.current.stop++; setSelected(childRunId); setDetail(null); setNotice(null); setStopping(false); setHistory(false);
    void readDetail(childRunId);
  }
  async function stop(childRunId = detail?.childRunId) {
    if (childRunId === undefined || stopping || !ready.current) return;
    const token = ++reads.current.stop;
    const current = () => alive.current && ready.current && reads.current.stop === token;
    setStopping(true); setNotice(null);
    try {
      const result = await window.flowmate.cancelSubagent({ parentRunId: props.parentRunId, childRunId });
      if (!current()) return;
      setNotice(result.ok ? result.data.accepted ? 'Stop requested. Actual stopping is being checked.' : 'No new stop was accepted. Read the saved child facts.'
        : result.error.code === 'operation_result_unknown' ? 'Stop receipt is unknown. Read the original child facts before retrying.' : `Stop could not be accepted (${result.error.code}).`);
      await load(); if (selection.current === childRunId) await readDetail(childRunId);
    } catch { if (current()) { setNotice('Stop receipt is unknown. Read the original child facts before retrying.'); await readDetail(childRunId); } }
    finally { if (current()) setStopping(false); }
  }
  if (props.compact && !items.length && !error) return null;
  return <section className={`panel ${props.compact ? 'chat-subagents' : ''}`} data-testid="subagents-panel"><div className="panel-head"><div><h2>Subagents</h2>
    {!props.compact && <p>Parent request {props.parentRunId} · Conversation {props.parentSessionId}</p>}</div>
    <button className="secondary-button" disabled={!props.ready || loading} onClick={refresh}>Refresh subagents</button></div>
    {!props.ready && <p className="notice bad" role="alert">The Host is unavailable. Saved details have not been reconfirmed.</p>}
    {error && <p className="notice bad" role="alert">{error}</p>}
    {loading && <p role="status">Loading subagents…</p>}
    {totals && !props.compact && <p className="activity-note" data-testid="subagent-total">Parent + all children · {totals.usageComplete ? 'Complete' : 'Partial'} ·
      {' '}Input / output / total tokens: {totals.inputTokens ?? 'Unknown'} / {totals.outputTokens ?? 'Unknown'} / {totals.totalTokens ?? 'Unknown'} ·
      {' '}Estimated cost: {totals.cost ?? 'Unknown'}</p>}
    {!loading && !error && items.length === 0 && <p>No delegation recorded.</p>}
    <div className="activity-tools">{items.map(child => <article key={child.childRunId} className="subagent-card">
      <button className="route-row" aria-pressed={selected === child.childRunId} onClick={() => select(child.childRunId)}>
        <strong>{child.description}</strong><span>{child.role} · {child.status} · Child {child.childRunId}</span></button>
      {summaries[child.childRunId]?.output && <p>{String(summaries[child.childRunId]!.output!.text ?? '').slice(0,240)}</p>}
      {summaries[child.childRunId]?.error && <p role="status">{summaries[child.childRunId]!.error!.code}</p>}
      {props.compact && ['created','running'].includes(child.status) && <button className="secondary-button" type="button"
        disabled={!props.ready || stopping || child.cancelRequestedAt !== null} onClick={() => void stop(child.childRunId)}>Stop {child.role}</button>}
    </article>)}</div>
    {next !== null && <button className="secondary-button" disabled={!props.ready || loading} onClick={() => void load(next)}>Load earlier subagents</button>}
    {detailError && <p className="notice bad" role="alert">{detailError}</p>}
    {detailLoading && <p role="status">Reading child facts…</p>}
    {detail && <div data-testid="subagent-detail"><h3>{detail.description}</h3><dl className="activity-facts">
      <div><dt>Child request / Session</dt><dd>{detail.childRunId} / {detail.childSessionId}</dd></div>
      <div><dt>Native Session</dt><dd>{detail.childNativeSessionId}</dd></div>
      <div><dt>Plugin agent</dt><dd>{detail.pluginAgentId}</dd></div>
      <div><dt>Original parent tool</dt><dd>{detail.originToolCallId} / {detail.parentNativeToolCallId}</dd></div>
      <div><dt>State</dt><dd>{detail.status}</dd></div>
      <div><dt>Stop intent</dt><dd>{detail.cancelRequestedAt ?? 'Not requested'}</dd></div>
      <div><dt>Actually stopped</dt><dd>{detail.stopConfirmed ? 'Confirmed' : ['created', 'running'].includes(detail.status) ? 'Not yet confirmed' : 'Unconfirmed'}</dd></div>
      <div><dt>Saved history</dt><dd>{detail.historyUsable ? 'Available to read' : 'Blocked for model use; saved prefix may be inspected'}</dd></div>
      <div><dt>Parent delivery</dt><dd>{detail.delivery.state === 'request_observed' ? 'Included in a parent model request' : `Parent receipt not confirmed · ${detail.delivery.state}`}</dd></div>
      <div><dt>Child input / output tokens</dt><dd>{detail.tokens.inputTokens ?? 'Unknown'} / {detail.tokens.outputTokens ?? 'Unknown'} · {detail.tokens.usageComplete ? 'Complete' : 'Incomplete'}</dd></div>
      <div><dt>Child cost</dt><dd>{detail.tokens.cost ?? 'Unknown'}</dd></div>
      <div><dt>Read-only tools</dt><dd>{detail.scope.allowedTools.join(', ')}</dd></div>
      <div><dt>Authorized documents / artifacts</dt><dd>{detail.scope.allowedDocumentIds.join(', ') || 'None'} / {detail.scope.allowedArtifactIds.join(', ') || 'None'}</dd></div>
    </dl><p className="activity-note">Read-only file tools can read paths permitted by the operating system. Tool selection does not create a path sandbox.</p>
      {detail.error && <p className="notice bad" role="status">Child issue: {detail.error.code}</p>}
      {!detail.historyUsable && <p className="notice bad" role="status">Recovery is blocked for this child. Refresh reads saved facts and does not resume execution.</p>}
      {!detail.stopConfirmed && !['created', 'running'].includes(detail.status) && <p className="notice bad" role="status">Stopping was not confirmed. Starting another request may remain blocked.</p>}
      <h4>Saved child result</h4><pre>{typeof detail.output?.text === 'string' ? detail.output.text : detail.output ? JSON.stringify(detail.output, null, 2) : 'No saved result.'}</pre>
      {detail.output?.partial === true && <p role="status">Saved partial output · Child execution did not complete.</p>}
      <div className="button-row"><button className="secondary-button" onClick={() => props.onObserve(detail.childRunId, detail.childSessionId)}>View child events</button>
        <button className="secondary-button" onClick={() => props.onObserve(props.parentRunId, props.parentSessionId)}>View parent events</button>
        <button className="secondary-button" disabled={!props.ready || stopping || !!detailError || !['created', 'running'].includes(detail.status) || detail.cancelRequestedAt !== null}
          onClick={() => void stop()}>Stop child</button>
        <button className="secondary-button" onClick={() => setHistory(value => !value)}>{history ? 'Hide child history' : 'Browse child history'}</button></div>
      {notice && <p role="status">{notice}</p>}
      {history && <div data-testid="subagent-history"><SessionHistory key={detail.childSessionId} sessionId={detail.childSessionId} hostEpoch={props.hostEpoch}
        navigationToken={detail.childRunId} hostReady={props.ready} readOnly onOwner={(sessionId, runId) => { if (sessionId === detail.childSessionId && runId === detail.childRunId) props.onObserve(runId, sessionId); }} /></div>}
    </div>}
  </section>;
}
