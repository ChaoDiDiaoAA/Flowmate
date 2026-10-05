import { useEffect, useRef, useState } from 'react';
import type { SessionCompactionSnapshot, RunSnapshot } from '@flowmate/contracts';
import { useRead, type ContextIdentity } from './context-state.ts';

type Props = { identity: ContextIdentity; hostReady: boolean; refreshToken: number; modelId: string | null;
  models: readonly { id: string; name: string }[]; onModelChange(id: string): void };

export function SessionCompaction(props: Props) {
  const [operationId, setOperationId] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const facts = useRead<SessionCompactionSnapshot>(props.identity, operationId ?? '');
  const runPolicy = useRead<RunSnapshot>(props.identity);
  const alive = useRef(true), writeToken = useRef(0);
  const identityKey = `${props.identity.hostEpoch}:${props.identity.sessionId}:${props.identity.runId}:${props.identity.selectionToken}`;
  const latest = useRef(identityKey); latest.current = identityKey;
  useEffect(() => { alive.current = true; return () => { alive.current = false; writeToken.current++; }; }, []);
  useEffect(() => { setOperationId(null); setBusy(false); setIssue(null); setNotice(null); writeToken.current++; }, [identityKey]);

  async function refresh() {
    if (!props.hostReady) return;
    await facts.read('compaction', () => window.flowmate.querySessionCompaction({ sessionId: props.identity.sessionId,
      ...(operationId ? { operationId } : props.identity.runId === null ? {} : { runId: props.identity.runId }) }),
      data => data.sessionId === props.identity.sessionId
        && (!operationId || !data.operation || data.operation.operationId === operationId)
        && (Boolean(operationId) || props.identity.runId === null || !data.operation || data.operation.runId === props.identity.runId),
      (previous, next) => previous?.operation && next.operation?.operationId === previous.operation.operationId
        && next.operation.observationSequence < previous.operation.observationSequence ? previous : next);
  }
  useEffect(() => { void refresh(); }, [identityKey, props.hostReady, operationId, props.refreshToken]);
  useEffect(() => {
    if (props.hostReady && props.identity.runId !== null)
      void runPolicy.read('run-policy', () => window.flowmate.queryRun(props.identity.runId!),
        run => run.kind === 'agent' && run.sessionId === props.identity.sessionId && run.runId === props.identity.runId);
  }, [identityKey, props.hostReady]);

  function writeLease() {
    const captured = identityKey, token = ++writeToken.current;
    return () => alive.current && latest.current === captured && writeToken.current === token;
  }
  async function compact() {
    const saved = facts.state.data;
    if (busy || !props.hostReady || facts.state.pending || facts.state.error || !saved?.manualAllowed || !props.modelId) return;
    const current = writeLease(), id = crypto.randomUUID();
    setBusy(true); setIssue(null); setNotice(null);
    try {
      const raw = await window.flowmate.compactSession({ sessionId: props.identity.sessionId, operationId: id,
        expected: saved.commit, modelId: props.modelId });
      if (!current()) return;
      if (raw.ok && (raw.data.sessionId !== props.identity.sessionId || raw.data.operationId !== id))
        setIssue('The operation receipt is unknown. Refresh its facts before a new attempt.');
      else if (!raw.ok) setIssue(raw.error.message);
      else setNotice('Compaction accepted. Waiting for execution and saved history.');
      // Even a lost acceptance is queried by this ID; it is never automatically resubmitted.
      setOperationId(id);
    } catch {
      if (current()) { setIssue('The operation receipt is unknown. Refresh before a new attempt.'); setOperationId(id); }
    } finally { if (current()) setBusy(false); }
  }
  async function cancel() {
    const operation = facts.state.data?.operation;
    if (busy || !props.hostReady || !operation || operation.stopped || operation.stopRequested) return;
    const current = writeLease(); setBusy(true); setIssue(null);
    try {
      const result = operation.runId === null
        ? await window.flowmate.cancelSessionCompaction({ sessionId: props.identity.sessionId, operationId: operation.operationId })
        : await window.flowmate.cancelRun(operation.runId);
      if (!current()) return;
      if (result.ok && (operation.runId === null
        ? !('sessionId' in result.data) || result.data.sessionId !== props.identity.sessionId || result.data.operationId !== operation.operationId
        : !('runId' in result.data) || result.data.runId !== operation.runId))
        setIssue('Cancellation could not be confirmed. Refresh its facts.');
      else if (!result.ok) setIssue(result.error.message);
      else setNotice(result.data.accepted ? 'Stop requested. Waiting for actual stop.' : 'No active operation accepted the stop request.');
      await refresh();
    } catch { if (current()) setIssue('Cancellation could not be confirmed. Refresh its facts.'); }
    finally { if (current()) setBusy(false); }
  }

  const saved = facts.state.data, operation = saved?.operation;
  const capacity = operation?.capacity ?? saved?.capacity;
  const frozen = runPolicy.state.data?.config.compactionPolicy;
  const frozenPolicy = frozen !== null && typeof frozen === 'object' ? frozen as Readonly<Record<string, unknown>> : null;
  return <section data-testid="session-compaction">
    <h3>Context compaction</h3>
    <p className="config-note">A lossy summary reduces future model context. Original history remains saved.</p>
    <p className="config-note">Capacity describes the last prepared runtime model. The selected manual model is applied during preparation.</p>
    <div className="context-controls">
      <label>Compaction model<select aria-label="Compaction model" value={props.modelId ?? ''} disabled={busy || !props.hostReady}
        onChange={event => props.onModelChange(event.target.value)}>
        {!props.modelId && <option value="">Choose a configured model</option>}
        {props.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
      </select></label>
      <button className="secondary-button" disabled={busy || !props.hostReady || facts.state.pending || Boolean(facts.state.error)
        || !saved?.manualAllowed || !props.models.some(model => model.id === props.modelId)} onClick={() => void compact()}>Compact context</button>
      <button className="text-button" disabled={busy || !props.hostReady || !operation || operation.stopped || operation.stopRequested}
        onClick={() => void cancel()}>Cancel compaction</button>
      <button className="text-button" disabled={!props.hostReady || facts.state.pending} onClick={() => void refresh()}>Refresh compaction</button>
    </div>
    {facts.state.pending && <p role="status">Loading compaction facts…</p>}
    {(issue || facts.state.error) && <p role="alert">{issue ?? facts.state.error}</p>}
    {notice && <p role="status">{notice}</p>}
    {saved && <dl className="activity-facts">
      <div><dt>Capacity estimate</dt><dd>{capacity?.tokens ?? 'Unknown'} tokens · {capacity?.source ?? 'unknown'}
        {' · '}window {capacity?.contextWindow ?? 'unknown'} · threshold {capacity?.thresholdTokens ?? 'unknown'}</dd></div>
      <div><dt>Capacity allows continuation</dt><dd>{capacity?.fitsEstimate === null ? 'Unknown' : capacity?.fitsEstimate ? 'Yes, estimated' : 'No'}</dd></div>
      <div><dt>Automatic default policy</dt><dd>{saved.policy.version} · {saved.policy.autoEnabled ? 'Enabled for qualified Runs' : 'Disabled'}</dd></div>
      <div><dt>Selected Run frozen policy</dt><dd>{typeof frozenPolicy?.version === 'string' && typeof frozenPolicy?.autoEnabled === 'boolean'
        ? `${frozenPolicy.version} · ${frozenPolicy.autoEnabled ? 'Enabled for this Run' : 'Disabled for this Run'}` : 'Unknown or not recorded'}</dd></div>
      <div><dt>Manual admission</dt><dd>{saved.manualAllowed ? 'Available while idle' : saved.blockCode ?? 'Unavailable'}</dd></div>
      <div><dt>Saved history position</dt><dd>Revision {saved.commit.commitRevision} · {saved.commit.entryCount} entries</dd></div>
      <div><dt>Last saved compaction</dt><dd>{saved.lastSaved?.entryId ?? 'None observed'}</dd></div>
      <div><dt>Operation evidence</dt><dd>{saved.operationAvailability}</dd></div>
    </dl>}
    {operation && <dl className="activity-facts" data-testid="compaction-operation">
      <div><dt>Operation</dt><dd>{operation.operationId} · {operation.reason} · {operation.phase}</dd></div>
      <div><dt>Summary generated</dt><dd>{operation.generated ? 'Yes' : 'No'}</dd></div>
      <div><dt>Execution ended</dt><dd>{operation.stopped ? 'Yes' : 'Not confirmed'} · {operation.nativeOutcome}</dd></div>
      <div><dt>History saved</dt><dd>{operation.saved ? `Yes · revision ${operation.saved.commitRevision} · ${operation.entryId}`
        : operation.generated ? 'No confirmed commit' : 'No new summary generated'}</dd></div>
      <div><dt>May continue</dt><dd>{operation.mayContinue ? 'Yes' : 'No'} · {operation.continuation}</dd></div>
      <div><dt>Stop requested</dt><dd>{operation.stopRequested ? 'Yes' : 'No'}</dd></div>
    </dl>}
    {operation?.error && <p role="alert">{operation.error.code} · {operation.error.message}</p>}
    {saved?.operationAvailability === 'unknown' && <p>The process has no confirmed facts for this operation. Saved history is shown separately.</p>}
  </section>;
}
