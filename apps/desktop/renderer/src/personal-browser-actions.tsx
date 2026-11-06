import { browserTabGroup, type BrowserReadView } from '@flowmate/contracts';
import { useEffect, useRef, useState } from 'react';

export function PersonalBrowserWindow({ workId, itemId, disabled, hostEpoch, workspaceId }: {
  workId: number; itemId: number; disabled: boolean; hostEpoch: number; workspaceId?: string;
}) {
  const [url, setUrl] = useState(''), [message, setMessage] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => { generation.current++; setUrl(''); setMessage(null); setBusy(false); return () => { generation.current++; }; },
    [workId, itemId, hostEpoch, workspaceId]);
  async function bind() {
    const token = ++generation.current; setBusy(true); setMessage(null);
    try {
      const result = await window.flowmate.selectBrowserPage({ workId, itemId, url, ...(workspaceId ? { workspaceId } : {}) });
      if (token === generation.current) setMessage(result.ok ? `Dedicated tab bound to ${result.data.origin}. Group: ${browserTabGroup({ workId, itemId, cloud: !!workspaceId })}.` : result.error.message);
    } catch { if (token === generation.current) setMessage('The browser tab could not be selected.'); }
    finally { if (token === generation.current) setBusy(false); }
  }
  return <section aria-label="Browser tab selection"><h4>Read a browser page</h4>
    <p>Open a dedicated Chrome tab for this invoice, then choose Continue work. Reading requires a separate approval each time.</p>
    <label className="field"><span>Page URL for this invoice</span><input type="url" maxLength={2048} value={url} disabled={disabled || busy}
      onChange={event => setUrl(event.target.value)} /></label>
    <button type="button" disabled={disabled || busy || !url.trim()} onClick={() => void bind()}>Open dedicated tab</button>
    {message && <p role="status">{message}</p>}
  </section>;
}

export function PersonalBrowserReads({ reads, cloud, disabled, onDecision, onRevoke }: {
  reads: readonly BrowserReadView[]; cloud: boolean; disabled: boolean;
  onDecision: (read: BrowserReadView, decision: 'approve' | 'reject') => void;
  onRevoke: (read: BrowserReadView) => void;
}) {
  if (!reads.length) return null;
  return <section aria-label="Browser read approvals"><h4>Browser reads</h4>{reads.map(read =>
    <article className="personal-todo" key={read.proposalId}>
      <p>Work {read.workId} · item {read.itemId} · dedicated tab {read.target.bindingId}</p>
      <p>Chrome tab group: {browserTabGroup({ workId: read.workId, itemId: read.itemId, cloud })}</p>
      <p>Allowed origin: {read.target.origin}. Other paths on this origin are included.</p>
      <p>The URL, title and page text may contain sensitive information. They may be saved in {cloud ? 'cloud Work history' : 'local Work history'} and sent to the selected model service.</p>
      <p>Read state: {read.status}</p>
      {read.status === 'unknown' && <p>The read outcome is unknown. Bind the tab and request a new approval before reading again.</p>}
      {read.status === 'waiting' && !read.canReject && <p>Waiting for the original phase to finish.</p>}
      {read.canReject && !read.canDecide && <p>The invoice or request changed. Reject it and request a new read.</p>}
      {(read.canDecide || read.canReject) && <div className="button-row">
        {read.canDecide && <button type="button" disabled={disabled} onClick={() => onDecision(read, 'approve')}>Approve one read and continue</button>}
        {read.canReject && <button type="button" disabled={disabled} onClick={() => onDecision(read, 'reject')}>Reject read</button>}
      </div>}
      {read.canRevoke && <button type="button" disabled={disabled} onClick={() => onRevoke(read)}>Revoke read</button>}
    </article>)}</section>;
}
