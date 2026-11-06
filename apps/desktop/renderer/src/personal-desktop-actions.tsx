import type { DesktopActionView } from '@flowmate/contracts';
import { useEffect, useRef, useState } from 'react';

export function PersonalDesktopWindow({ workId, itemId, disabled, hostEpoch, workspaceId }: {
  workId: number; itemId: number; disabled: boolean; hostEpoch: number; workspaceId?: string;
}) {
  const [windows, setWindows] = useState<DesktopActionView['target']['window'][]>([]), [selected, setSelected] = useState('');
  const [message, setMessage] = useState<string | null>(null), [busy, setBusy] = useState(false), generation = useRef(0);
  useEffect(() => { generation.current++; setWindows([]); setSelected(''); setMessage(null); setBusy(false);
    return () => { generation.current++; }; }, [workId, itemId, hostEpoch, workspaceId]);
  async function list() {
    const token = ++generation.current; setBusy(true); setMessage(null);
    try {
      const result = await window.flowmate.desktopWindows(); if (token !== generation.current) return;
      if (result.ok) { setWindows(result.data); setSelected(''); setMessage(result.data.length ? 'Choose the exact window for this invoice.' : 'No windows were found.'); }
      else setMessage(result.error.message);
    } catch { if (token === generation.current) setMessage('The desktop window list is unavailable.'); }
    finally { if (token === generation.current) setBusy(false); }
  }
  async function bind() {
    const target = windows.find(value => String(value.id) === selected); if (!target) return;
    const token = ++generation.current; setBusy(true); setMessage(null);
    try {
      const result = await window.flowmate.selectDesktopWindow({ workId, itemId, window: target, ...(workspaceId ? { workspaceId } : {}) });
      if (token === generation.current) setMessage(result.ok ? `Selected ${target.app} · ${target.title} for this invoice.` : result.error.message);
    } catch { if (token === generation.current) setMessage('The window selection could not be confirmed.'); }
    finally { if (token === generation.current) setBusy(false); }
  }
  return <section aria-label="Desktop window selection"><h4>External Windows application</h4>
    <p>Kimi recommends against tasks involving money, accounts or publishing. Confirmation reduces but does not remove the risk.</p>
    <p>Input can activate the selected window and use your mouse and keyboard.</p>
    <p>At most 100 windows are shown; choose the exact target for this invoice.</p>
    <button type="button" disabled={disabled || busy} onClick={() => void list()}>Find desktop windows</button>
    <label className="field"><span>Window for this invoice</span><select value={selected} disabled={disabled || busy}
      onChange={event => setSelected(event.target.value)}><option value="">Choose a window</option>
      {windows.map(value => <option key={value.id} value={String(value.id)}>{value.app} · {value.title} · {value.id}</option>)}</select></label>
    <button type="button" disabled={disabled || busy || !selected} onClick={() => void bind()}>Select this window</button>
    {message && <p role="status">{message}</p>}
  </section>;
}

export function PersonalDesktopActions({ actions, disabled, onDecision, onDiscard }: {
  actions: readonly DesktopActionView[]; disabled: boolean;
  onDecision: (action: DesktopActionView, decision: 'approve' | 'reject') => void;
  onDiscard: (action: DesktopActionView) => void;
}) {
  if (!actions.length) return null;
  return <section aria-label="Desktop action approvals"><h4>Desktop actions</h4>{actions.map(action =>
    <article className="personal-todo" key={action.proposalId}>
      <p>Application: {action.target.window.app} · Window: {action.target.window.title} · Window ID: {action.target.window.id}</p>
      <p>Control: {action.target.element}</p>
      <p>Action: {action.action.kind.replaceAll('_', ' ')} · State: {action.status}</p>
      {'value' in action.action && <pre>{action.action.value}</pre>}
      {'text' in action.action && <><pre>{action.action.text}</pre><p>Typing replaces the system clipboard.</p></>}
      {action.status === 'unknown' && <p>The input may already have happened. Inspect the original application before proposing another action.</p>}
      {action.status === 'dispatched' && <p>The input was dispatched; the business result is not confirmed.</p>}
      {action.status === 'invalidated' && <p>The approval is no longer usable. Observe the target and confirm a new request.</p>}
      {action.status === 'approved' && <button type="button" disabled={disabled} onClick={() => onDiscard(action)}>Discard approval</button>}
      {action.status === 'waiting' && !action.canReject && <p>Waiting for the original phase to finish.</p>}
      {action.canReject && !action.canDecide && <p>The invoice or original proposal result changed. Discard this request and observe the target again.</p>}
      {(action.canDecide || action.canReject) && <div className="button-row">
        {action.canDecide && <button type="button" disabled={disabled} onClick={() => onDecision(action, 'approve')}>Approve and continue</button>}
        {action.canReject && <button type="button" disabled={disabled} onClick={() => onDecision(action, 'reject')}>{action.canDecide ? 'Reject action' : 'Discard outdated request'}</button>}
      </div>}
    </article>)}</section>;
}
