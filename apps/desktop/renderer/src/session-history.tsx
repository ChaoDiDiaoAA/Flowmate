import { useEffect, useRef, useState } from 'react';
import type { ForkSessionRequest, ForkSessionResult, NativeHistoryPage, SessionHistoryEntryDetail, SessionHistoryEntryRequest, Result } from '@flowmate/contracts';
import { acceptHistoryRead, beginHistoryRead, createHistoryRead, failHistoryRead, finishHistoryRead, freezeForkRequest, historyError, invalidateHistoryRead,
  historyLease, matchesHistoryDetail, matchesHistoryRead, mergeHistoryPage, sameHistoryIdentity, type HistoryIdentity } from './history-state.ts';

type Props = { sessionId: number; hostEpoch: number; navigationToken: number; hostReady: boolean;
  initialForkRequest: ForkSessionRequest | null; onForkRequest(request: ForkSessionRequest | null): void;
  selectionToken: number; captureSelection(): () => boolean;
  onBranch(sessionId: number): void;
  onFork(result: ForkSessionResult, current: () => boolean): Promise<boolean>;
  onOwner(sessionId: number, runId: number | null): void };
type TextDetail = { detail: SessionHistoryEntryDetail; chunks: readonly { kind: string; text: string }[] };
function useHistoryRead<T>(identity: HistoryIdentity) {
  const state = useRef(createHistoryRead<T>(identity)), sequence = useRef(0), alive = useRef(true);
  const [, render] = useState(0);
  if (!sameHistoryIdentity(state.current.identity, identity)) state.current = createHistoryRead<T>(identity);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function read(key: string, query: () => Promise<Result<T>>, validate: (value: T) => boolean = () => true) {
    state.current = beginHistoryRead(state.current, ++sequence.current, key);
    const lease = historyLease(state.current), current = () => alive.current && matchesHistoryRead(state.current, lease);
    render(n => n + 1);
    try {
      const result = await query();
      if (!current()) return null;
      if (!result.ok) state.current = failHistoryRead(state.current, lease, historyError(result.error.code));
      else if (!validate(result.data)) state.current = failHistoryRead(state.current, lease, 'History is unavailable.');
      else { state.current = acceptHistoryRead(state.current, lease, result.data); return result.data; }
      return null;
    } catch { if (current()) state.current = failHistoryRead(state.current, lease, 'History is unavailable.'); return null; }
    finally { if (current()) { state.current = finishHistoryRead(state.current, lease); render(n => n + 1); } }
  }
  function invalidate() { state.current = invalidateHistoryRead(state.current, ++sequence.current); render(n => n + 1); }
  return { state: state.current, read, invalidate };
}
export function SessionHistory(props: Props) {
  const [opened, setOpened] = useState(false), [entryId, setEntryId] = useState<string | null>(null), [generation, setGeneration] = useState(0);
  const [title, setTitle] = useState('Forked chat'), [confirming, setConfirming] = useState(props.initialForkRequest !== null), [frozen, setFrozen] = useState(props.initialForkRequest);
  const [notice, setNotice] = useState<string | null>(null), [pending, setPending] = useState(false);
  const [detailRefresh, setDetailRefresh] = useState(0);
  const identity: HistoryIdentity = { sessionId: props.sessionId, hostEpoch: props.hostEpoch, navigationToken: props.navigationToken, entryId: opened ? 'open' : 'closed' };
  const pages = useHistoryRead<NativeHistoryPage>(identity);
  const details = useHistoryRead<TextDetail>({ ...identity, entryId: `${entryId}:${pages.state.data?.commit.commitRevision}` });
  const operation = useRef(0), alive = useRef(true), latest = useRef('');
  const identityKey = `${props.sessionId}:${props.hostEpoch}:${props.navigationToken}:${opened}`;
  const leaseKey = `${identityKey}:${entryId}:${generation}`;
  latest.current = leaseKey;
  useEffect(() => { alive.current = true; return () => { alive.current = false; operation.current++; }; }, []);
  useEffect(() => { operation.current++; setPending(false); setNotice(null); }, [leaseKey, props.selectionToken]);
  const page = pages.state.data, selected = page?.items.find(item => item.entryId === entryId);
  async function load(afterSequence?: number) {
    if (!props.hostReady) return;
    const held = pages.state.data;
    if (afterSequence !== undefined && !held) return;
    const input = { sessionId: props.sessionId, limit: 50, ...(afterSequence === undefined ? {} : { afterSequence, expectedCommitRevision: held!.commit.commitRevision }) };
    const loaded = await pages.read(JSON.stringify(input), async () => {
      const result = await window.flowmate.querySessionHistory(input);
      if (!result.ok) return result;
      const merged = mergeHistoryPage(held, result.data, afterSequence);
      return merged ? { ok: true, data: merged } : { ok: false, error: { code: 'state_conflict', category: 'runtime', retryable: false, message: 'History changed. Reload to continue.' } };
    }, value => value.session.sessionId === props.sessionId);
    if (loaded && afterSequence === undefined) setDetailRefresh(n => n + 1);
  }
  async function loadDetail(next?: { partIndex: number; offset: number }) {
    if (!page || !entryId || !props.hostReady) return;
    const input: SessionHistoryEntryRequest = { sessionId: props.sessionId, entryId, expectedCommitRevision: page.commit.commitRevision, ...(next ?? { partIndex: 0, offset: 0 }) };
    const prior = next ? details.state.data?.chunks ?? [] : [];
    await details.read(JSON.stringify(input), async () => {
      const result = await window.flowmate.querySessionHistoryEntry(input);
      if (!result.ok) return result;
      if (!matchesHistoryDetail(page, input, result.data)) return { ok: false, error: { code: 'internal_error', category: 'internal', retryable: false, message: 'History is unavailable.' } };
      return { ok: true, data: { detail: result.data, chunks: result.data.part ? [...prior, result.data.part] : prior } };
    });
  }
  useEffect(() => { if (opened) void load(); }, [identityKey, props.hostReady]);
  useEffect(() => { if (opened && entryId) void loadDetail(); }, [identityKey, entryId, page?.commit.commitRevision, detailRefresh, props.hostReady]);
  async function manage(kind: 'branch' | 'fork') {
    if (!page || pending || !props.hostReady || kind === 'branch' && !selected?.canSelect || kind === 'fork' && !frozen && !selected?.canSelect) return;
    let forkInput = frozen;
    if (kind === 'fork' && !forkInput) {
      try { forkInput = freezeForkRequest({ sourceSessionId: props.sessionId, expected: page.commit, targetEntryId: selected!.entryId, title, clientOperationId: crypto.randomUUID() }); }
      catch { setNotice('Session history request is invalid.'); return; }
      setFrozen(forkInput);
      props.onForkRequest(forkInput);
    }
    const key = latest.current, token = ++operation.current;
    const selectionCurrent = props.captureSelection();
    const current = () => alive.current && latest.current === key && operation.current === token && selectionCurrent();
    setPending(true); setNotice(null);
    try {
      if (kind === 'branch') {
        const result = await window.flowmate.branchSession({ sessionId: props.sessionId, expectedCommitRevision: page.commit.commitRevision,
          expectedLeafId: page.commit.leafId, expectedEntryCount: page.commit.entryCount, targetEntryId: selected!.entryId });
        if (!current()) return;
        if (!result.ok) { setNotice(result.error.message); return; }
        props.onBranch(props.sessionId); setNotice('Chat position saved.'); await load();
      } else {
        const result = await window.flowmate.forkSession(forkInput!);
        if (!current()) return;
        if (!result.ok) { setNotice(result.error.message); return; }
        const selectedTarget = await props.onFork(result.data, current);
        if (selectedTarget) props.onForkRequest(null);
        if (current()) setNotice(selectedTarget ? 'Forked chat selected.' : `Forked chat ${result.data.session.sessionId} is saved. Workspace selection was not confirmed.`);
      }
    } catch { if (current()) setNotice(kind === 'fork' ? 'The fork receipt is unknown. Retry the same fork request to check its result.' : 'History is unavailable.'); }
    finally { if (current()) setPending(false); }
  }
  return <section className="session-history"><h3>History</h3>
    <button className="secondary-button" onClick={() => setOpened(value => !value)}>{opened ? 'Hide history' : 'Browse history'}</button>
    {opened && <><button className="text-button" disabled={!props.hostReady || pages.state.pending} onClick={() => { details.invalidate(); setGeneration(n => n + 1); void load(); }}>Reload history</button>
      {(!props.hostReady || pages.state.error) && <p className="notice bad" role="alert">{pages.state.error ?? 'History is unavailable.'}</p>}
      {!pages.state.error && page && (page.session.historyState === 'invalid' || page.session.availability === 'unusable' || page.session.availability === 'history-unavailable')
        && <p className="notice bad" role="alert">History is unavailable.</p>}
      {pages.state.pending && <p role="status">Loading history…</p>}
      {page && <><p>Saved revision {page.commit.commitRevision} · Current position {page.commit.leafId ?? 'Empty'} · {page.commit.entryCount} entries</p>
        <ol className="history-tree">{page.items.map(item => <li key={item.entryId} data-parent-id={item.parentId ?? ''}>
          <button className="text-button" data-testid={`history-entry-${item.entryId}`} aria-pressed={entryId === item.entryId} onClick={() => setEntryId(item.entryId)}>
            {item.sequence + 1} · {item.type} · {item.preview || 'No text'}{item.truncated ? '…' : ''}</button>
          <p>Entry {item.entryId} · Parent {item.parentId ?? 'Root'} · {item.isLeaf ? 'Current position' : item.isCurrentPath ? 'Current path' : 'Other branch'}</p>
          <button className="text-button" onClick={() => props.onOwner(item.originSessionId, item.originRunId)}>Source Session {item.originSessionId}{item.originRunId === null ? '' : ` / Run ${item.originRunId}`}</button>
          {!item.canSelect && <p>Read only · {item.cannotSelectReason}</p>}</li>)}</ol>
        {page.nextAfterSequence !== null && <button className="secondary-button" disabled={pages.state.pending} onClick={() => void load(page.nextAfterSequence!)}>More history</button>}
      </>}
      {details.state.error && <p className="notice bad" role="alert">{details.state.error}</p>}
      {details.state.pending && <p role="status">Loading entry…</p>}
      {selected && <section aria-label="History entry"><h4>{selected.type} · Entry {selected.entryId}</h4>
        {details.state.data && <><dl className="activity-facts">{Object.entries(details.state.data.detail.fields).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value === null ? 'Not recorded' : typeof value === 'object' && !Array.isArray(value) && 'text' in value ? String(value.text) : Array.isArray(value) ? value.join(', ') : String(value)}</dd></div>)}</dl>
          <pre data-testid="history-text">{details.state.data.chunks.map(chunk => chunk.text).join('')}</pre>
          {details.state.data.detail.next && <button className="secondary-button" disabled={details.state.pending} onClick={() => void loadDetail(details.state.data!.detail.next!)}>More text</button>}</>}
        <button className="secondary-button" disabled={!selected.canSelect || pending || !props.hostReady || !!pages.state.error || !!details.state.error} onClick={() => void manage('branch')}>Continue here</button>
        <button className="secondary-button" disabled={!selected.canSelect || pending || !props.hostReady || !!pages.state.error} onClick={() => setConfirming(true)}>Fork chat</button>
      </section>}
      {confirming && <div className="history-fork"><label>Fork title<input aria-label="Fork title" value={title} onChange={event => setTitle(event.target.value)} /></label>
        <button className="primary-button" disabled={pending || !props.hostReady} onClick={() => void manage('fork')}>{frozen ? 'Retry same fork' : 'Confirm fork'}</button>
        {frozen && <p>Retry uses the originally confirmed entry, saved revision and title.</p>}
        {frozen && <button className="text-button" disabled={pending || !props.hostReady || !selected?.canSelect}
          onClick={() => { operation.current++; setFrozen(null); props.onForkRequest(null); setNotice(null); }}>Start new fork</button>}
      </div>}
      {notice && <p role="status">{notice}</p>}
    </>}
  </section>;
}
