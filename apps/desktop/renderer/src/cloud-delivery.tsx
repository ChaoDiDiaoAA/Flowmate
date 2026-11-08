import { useEffect, useRef, useState } from 'react';
import { CloudRuntimeRetryReceiptSchema, CloudRuntimeStatusSchema, type CloudDesktopUserCommand,
  type CloudQueueOwner, type CloudRuntimeStatus } from '@flowmate/contracts';

export function CloudDeliveryPanel(props: { workspaceId: string; owner: Omit<CloudQueueOwner, 'itemId'> | null; refreshSignal: number }) {
  const [status, setStatus] = useState<CloudRuntimeStatus | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [message, setMessage] = useState<string | null>(null);
  const generation = useRef(0), active = useRef(false), owner = props.owner;
  async function request(command: CloudDesktopUserCommand) {
    const result = await window.flowmate.cloudDesktop.request({ workspaceId: props.workspaceId, command });
    if (!result.ok) throw Error(result.error.message); return result.data;
  }
  async function load(target: Omit<CloudQueueOwner, 'itemId'>, token: number, afterSubmissionId?: number) {
    const data = CloudRuntimeStatusSchema.parse(await request({ type: 'cloud_delivery_status', input: { ...target, limit: 50,
      ...(afterSubmissionId === undefined ? {} : { afterSubmissionId }) } }));
    if (token !== generation.current) return;
    setStatus(previous => afterSubmissionId === undefined || !previous ? data : { ...data,
      results: { ...data.results, items: [...previous.results.items, ...data.results.items] } });
  }
  useEffect(() => {
    const token = ++generation.current; setStatus(null); setError(null); setMessage(null);
    if (owner) void load(owner, token).catch(cause => { if (token === generation.current) setError(cause instanceof Error ? cause.message : 'Cloud delivery status is unavailable.'); });
    return () => { generation.current++; };
  }, [props.workspaceId, owner?.workId, owner?.sessionId, owner?.attemptId, props.refreshSignal]);
  async function run(action: (token: number) => Promise<void>) {
    if (active.current) return; active.current = true; setBusy(true); setError(null); setMessage(null);
    const token = generation.current;
    try { await action(token); }
    catch (cause) { if (token === generation.current) setError(cause instanceof Error ? cause.message : 'The original result delivery could not be confirmed.'); }
    finally { active.current = false; setBusy(false); }
  }
  return <section className="panel" aria-label="Cloud result delivery"><h2>Cloud result delivery</h2>
    {error && <p role="alert">{error} Refresh the delivery status to check the original result.</p>}{message && <p role="status">{message}</p>}
    {!owner ? <p>Select a cloud Work with an execution attempt to inspect delivery.</p> : <>
      <button type="button" disabled={busy} onClick={() => void run(token => load(owner, token))}>Refresh result delivery</button>
      {status && <p>Native observation version {status.observationRevision}</p>}
      {status && <details><summary>Native session status</summary>
        <p>Session {status.native.conversationId}; task and submission states may include earlier attempts for this Work.</p>
        {status.native.tasks.map(task => <p key={task.taskId}>Task {task.taskId} · {task.kind} · {task.status}{task.abortRequested ? ' · abort requested' : ''}</p>)}
        {status.native.submissions.map(item => <p key={item.submissionId}>Submission {item.submissionId} · {item.type} · {item.status}</p>)}
        {(status.native.moreTasks || status.native.moreSubmissions) && <p>Only the most recent 50 tasks and submissions are shown; use history for earlier entries.</p>}
      </details>}
      {status?.wake?.blocked && <p>Automatic wake is blocked.</p>}
      {status?.wake?.active && !status.wake.blocked && <p>Automatic wake is active{status.wake.at === null ? '.' : ` · ${new Date(status.wake.at).toLocaleString()}`}</p>}
      {status?.results.items.map(item => <article key={item.nativeSubmissionId}>
        <p>Result {item.nativeSubmissionId} · {item.state} · {item.attempts} delivery attempts</p>
        <p>Original phase {item.requestId} · {item.nativeStatus}{item.itemId === undefined ? '' : ` · Invoice item ${item.itemId}`}</p>
        {item.blockedReason === 'size_limit' && <p>The original result exceeds the delivery limit and remains in its native record.</p>}
        {item.state === 'pending' && item.nextAt && <p>Next delivery attempt: {item.nextAt}</p>}
        {item.state === 'blocked' && <button type="button" disabled={busy} onClick={() => void run(async token => {
          CloudRuntimeRetryReceiptSchema.parse(await request({ type: 'cloud_delivery_retry', input: { ...owner,
            ...(item.itemId === undefined ? {} : { itemId: item.itemId }), requestId: item.requestId, nativeSubmissionId: item.nativeSubmissionId } }));
          if (token === generation.current) { setMessage('The original result was queued for delivery.'); await load(owner, token); }
        })}>Retry original result {item.nativeSubmissionId}</button>}
      </article>)}
      {status?.results.nextAfterSubmissionId && <button type="button" disabled={busy}
        onClick={() => void run(token => load(owner, token, status.results.nextAfterSubmissionId!))}>More delivery results</button>}
    </>}
  </section>;
}
