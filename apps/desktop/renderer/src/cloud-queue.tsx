import { useEffect, useRef, useState } from 'react';
import { CloudQueueControlSchema, CloudQueueReceiptSchema, CloudQueueViewSchema,
  type CloudDesktopUserCommand, type CloudQueueControl, type CloudQueueOwner, type CloudQueueView } from '@flowmate/contracts';
import { clearCloudQueueControl, readCloudQueueControl, saveCloudQueueControl } from './cloud-queue-state.ts';

export function CloudQueuePanel(props: { workspaceId: string; owner: CloudQueueOwner | null; refreshSignal: number; onChanged(): void }) {
  const [initial] = useState(() => readCloudQueueControl(localStorage, props.workspaceId));
  const [pending, setPending] = useState<CloudQueueControl | null>(initial.ok ? initial.data : null), pendingRef = useRef(pending);
  const [queue, setQueue] = useState<CloudQueueView | null>(null), [edits, setEdits] = useState<Record<number, { base: string; text: string }>>({});
  const [instruction, setInstruction] = useState('');
  const [error, setError] = useState<string | null>(initial.ok ? null : initial.error.message), [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [retryReady, setRetryReady] = useState(false), active = useRef(false), generation = useRef(0);
  const owner = props.owner;
  const ownerRef = useRef(owner), loadedOwner = useRef<string | null>(null), displayedOwner = useRef<string | null>(null);
  const instructions = useRef(new Map<string, string>());
  const ownerKey = (value: CloudQueueOwner) => JSON.stringify([value.workId, value.sessionId, value.attemptId, value.itemId ?? null]);
  useEffect(() => { ownerRef.current = owner; }, [owner?.workId, owner?.sessionId, owner?.attemptId, owner?.itemId]);
  async function request(command: CloudDesktopUserCommand) {
    const result = await window.flowmate.cloudDesktop.request({ workspaceId: props.workspaceId, command });
    if (!result.ok) throw Error(result.error.message); return result.data;
  }
  async function load(target: CloudQueueOwner, token = generation.current) {
    const view = CloudQueueViewSchema.parse(await request({ type: 'cloud_queue_read', input: target }));
    if (token !== generation.current) return;
    if (view.workId !== target.workId || view.sessionId !== target.sessionId || view.attemptId !== target.attemptId || view.itemId !== target.itemId)
      throw Error('The queue belongs to another invoice.');
    const key = ownerKey(target), sameOwner = loadedOwner.current === key;
    loadedOwner.current = key; setQueue(view);
    setEdits(previous => Object.fromEntries(view.items.map(item => {
      const saved = sameOwner ? previous[item.submissionId] : undefined;
      return [item.submissionId, saved && saved.text !== saved.base ? saved : { base: item.content, text: item.content }];
    })));
  }
  useEffect(() => {
    const token = ++generation.current, key = owner ? ownerKey(owner) : null;
    if (displayedOwner.current !== key) { displayedOwner.current = key; setQueue(null); setEdits({}); setInstruction(key ? instructions.current.get(key) ?? '' : ''); }
    if (owner) void load(owner, token).catch(cause => { if (token === generation.current) setError(cause instanceof Error ? cause.message : 'Cloud queue is unavailable.'); });
    return () => { generation.current++; };
  }, [props.workspaceId, owner?.workId, owner?.sessionId, owner?.attemptId, owner?.itemId, props.refreshSignal]);
  async function run(action: () => Promise<void>) {
    if (active.current) return; active.current = true; setBusy(true); setError(null); setMessage(null);
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'The original queue control could not be confirmed.'); }
    finally { active.current = false; setBusy(false); }
  }
  async function received(raw: unknown, original: CloudQueueControl) {
    const receipt = CloudQueueReceiptSchema.parse(raw);
    if (receipt.workId !== original.workId || receipt.sessionId !== original.sessionId || receipt.attemptId !== original.attemptId
      || receipt.itemId !== original.itemId || receipt.controlRequestId !== original.controlRequestId) throw Error('The queue receipt belongs to another control.');
    if (!clearCloudQueueControl(localStorage, props.workspaceId)) throw Error('The confirmed control could not be cleared from this device.');
    pendingRef.current = null; setPending(null); setRetryReady(false);
    if (receipt.status === 'applied' && original.action.kind === 'enqueue' && instructions.current.get(ownerKey(original)) === original.action.content) {
      instructions.current.delete(ownerKey(original));
      if (ownerRef.current && ownerKey(ownerRef.current) === ownerKey(original)) setInstruction('');
    }
    if (receipt.status === 'applied' && original.action.kind === 'edit' && ownerRef.current?.workId === original.workId
      && ownerRef.current.sessionId === original.sessionId && ownerRef.current.attemptId === original.attemptId && ownerRef.current.itemId === original.itemId) {
      const action = original.action;
      setEdits(previous => previous[action.submissionId]?.text === action.content ? { ...previous,
        [action.submissionId]: { base: action.content, text: action.content } } : previous);
    }
    setMessage(receipt.status === 'applied' ? 'The original queue control was applied.' : 'The queue changed before this control was applied.');
    props.onChanged(); if (ownerRef.current) await load(ownerRef.current);
  }
  async function apply(action: CloudQueueControl['action']) {
    if (!initial.ok || !owner || !queue || pendingRef.current) return;
    const control = CloudQueueControlSchema.parse({ ...owner, controlRequestId: crypto.randomUUID(), expectedVersion: queue.version, action });
    if (!saveCloudQueueControl(localStorage, props.workspaceId, control)) throw Error('The original queue control could not be saved. No control was sent.');
    pendingRef.current = control; setPending(control); setRetryReady(false);
    await received(await request({ type: 'cloud_queue_control', input: control }), control);
  }
  async function recover(retry = false) {
    const original = pendingRef.current; if (!original) return;
    const receipt = await request({ type: 'cloud_queue_query_control', input: { workId: original.workId, sessionId: original.sessionId,
      ...(original.itemId === undefined ? {} : { itemId: original.itemId }), attemptId: original.attemptId, controlRequestId: original.controlRequestId } });
    if (receipt !== null) { await received(receipt, original); return; }
    setRetryReady(true); setMessage('No saved control receipt was found. The original control remains available.');
    if (retry) await received(await request({ type: 'cloud_queue_control', input: original }), original);
  }
  function move(index: number, direction: -1 | 1) {
    if (!queue) return; const target = index + direction; if (target < 0 || target >= queue.items.length) return;
    const ids = queue.items.map(item => item.submissionId); [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    void run(() => apply({ kind: 'reorder', submissionIds: ids }));
  }
  return <section className="panel" aria-label="Cloud execution queue"><h2>Cloud execution queue</h2>
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {!initial.ok && <p>The saved control cannot be verified; it has not been replaced.</p>}
    {pending && <div className="notice"><p>Original control for Work {pending.workId}, attempt {pending.attemptId} awaits confirmation.</p>
      <button type="button" disabled={busy} onClick={() => void run(() => recover())}>Check queue control receipt</button>
      {retryReady && <button type="button" disabled={busy} onClick={() => void run(() => recover(true))}>Retry original queue control</button>}</div>}
    {!owner ? <p>Select a cloud Work and invoice with an execution attempt to inspect its queue.</p> : <>
      <button type="button" disabled={busy} onClick={() => void run(() => load(owner))}>Refresh cloud queue</button>
      {queue && <><p>Queue version {queue.version} · {queue.items.length} pending input(s)</p>
        {queue.activePhaseRequestId && <div><label className="field"><span>New cloud queue instruction</span><textarea maxLength={22000}
          value={instruction} disabled={busy || !!pending || !initial.ok} onChange={event => {
            instructions.current.set(ownerKey(owner), event.target.value); setInstruction(event.target.value);
          }} /></label>
          <p>This instruction stays within the current invoice and its existing tool permissions.</p><div className="button-row">
            <button type="button" disabled={busy || !!pending || !initial.ok || !instruction.trim()} onClick={() => void run(() => apply({ kind: 'enqueue',
              phaseRequestId: queue.activePhaseRequestId!, mode: 'steer', content: instruction }))}>Send steer</button>
            <button type="button" disabled={busy || !!pending || !initial.ok || !instruction.trim()} onClick={() => void run(() => apply({ kind: 'enqueue',
              phaseRequestId: queue.activePhaseRequestId!, mode: 'followUp', content: instruction }))}>Send follow-up</button></div></div>}
        {queue.items.map((item, index) => { const edit = edits[item.submissionId] ?? { base: item.content, text: item.content };
          const stale = edit.base !== item.content;
          return <article key={item.submissionId}><h3>Input {item.submissionId} · {item.mode}</h3>
          <label className="field"><span>Queued input {item.submissionId}</span><textarea maxLength={22000} disabled={busy || !!pending || !initial.ok}
            value={edit.text} onChange={event => { const text = event.target.value;
              setEdits(previous => ({ ...previous, [item.submissionId]: { base: previous[item.submissionId]?.base ?? item.content, text } })); }} /></label>
          {stale && <div className="notice"><p>The queued input changed. Your unsent edit is retained.</p><p>Current queued input: {item.content}</p>
            <button type="button" disabled={busy || !!pending} onClick={() => setEdits(previous => ({ ...previous,
              [item.submissionId]: { base: item.content, text: item.content } }))}>Use current queued input</button></div>}
          <div className="button-row"><button type="button" disabled={busy || !!pending || !initial.ok || stale || !edit.text.trim() || edit.text === item.content}
            onClick={() => void run(() => apply({ kind: 'edit', submissionId: item.submissionId, content: edit.text }))}>Save queued edit</button>
            <button type="button" disabled={busy || !!pending || !initial.ok || item.mode === 'steer'} onClick={() => void run(() => apply({ kind: 'mode', submissionId: item.submissionId, mode: 'steer' }))}>Set steer</button>
            <button type="button" disabled={busy || !!pending || !initial.ok || item.mode === 'followUp'} onClick={() => void run(() => apply({ kind: 'mode', submissionId: item.submissionId, mode: 'followUp' }))}>Set follow-up</button>
            <button type="button" disabled={busy || !!pending || !initial.ok || index === 0} onClick={() => move(index, -1)}>Move up</button>
            <button type="button" disabled={busy || !!pending || !initial.ok || index === queue.items.length - 1} onClick={() => move(index, 1)}>Move down</button>
            <button type="button" disabled={busy || !!pending || !initial.ok} onClick={() => void run(() => apply({ kind: 'cancel', submissionId: item.submissionId }))}>Cancel queued input</button></div></article>; })}
      </>}
    </>}
  </section>;
}
