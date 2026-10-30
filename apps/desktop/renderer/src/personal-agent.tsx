import { useEffect, useRef, useState } from 'react';
import { compareInvoiceWorkTimelineCursor, type DocumentSnapshot, type InvoiceWorkView, type InvoiceWorkItemView,
  type InvoiceWorkTodoView, type InvoiceWorkTimelinePage, type ModelProfile, type PersonalAgentConfiguration,
  type PersonalAgentSnapshot, type PersonalHistoryPage, type PersonalHistoryEntry, type PersonalHistoryTarget,
  type PersonalTaskView, type PersonalTaskGetResult, type Result } from '@flowmate/contracts';
import { capturePersonalWrite, emptyPersonalDraft, executePersonalWrite, readPersonalDraft, recoverPersonalWrite,
  savePersonalDraft, personalReceiptText, type PersonalDraft, type PersonalReviewTarget, type PersonalWriteCommand,
  type PersonalWriteReceipt } from './personal-state.ts';
import { PersonalConfiguration } from './personal-configuration.tsx';

type Props = { ready: boolean; hostEpoch: number; models: readonly ModelProfile[];
  onModels(): void; onOpenInvoice(target: PersonalReviewTarget): Promise<void> };
function need<T>(result: Result<T>): T { if (!result.ok) throw Error(result.error.message); return result.data; }
const requestId = () => crypto.randomUUID();
const title = (value: string) => value.replaceAll('_', ' ');
const supplementKey = (workId: number, itemId: number, todoId: number) => `${workId}:${itemId}:${todoId}`;

export function PersonalAgentPage(props: Props) {
  const [initial] = useState(() => readPersonalDraft(localStorage));
  const [draft, setDraft] = useState<PersonalDraft>(initial.ok ? initial.data : emptyPersonalDraft());
  const draftRef = useRef(draft);
  const [draftError, setDraftError] = useState(initial.ok ? null : initial.error.message);
  const [agent, setAgent] = useState<PersonalAgentSnapshot | null>(null);
  const [configuration, setConfiguration] = useState<{ revision: number; value: PersonalAgentConfiguration } | null>(null);
  const [works, setWorks] = useState<readonly InvoiceWorkView[]>([]), [workCursor, setWorkCursor] = useState<number | null>(null);
  const [work, setWork] = useState<InvoiceWorkView | null>(null), [items, setItems] = useState<readonly InvoiceWorkItemView[]>([]);
  const [itemCursor, setItemCursor] = useState<number | null>(null), [selectedItem, setSelectedItem] = useState<InvoiceWorkItemView | null>(null);
  const [todos, setTodos] = useState<readonly InvoiceWorkTodoView[]>([]), [todoCursor, setTodoCursor] = useState<number | null>(null);
  const [documents, setDocuments] = useState<DocumentSnapshot[]>([]), [documentCursor, setDocumentCursor] = useState<number | null>(null);
  const [tasks, setTasks] = useState<readonly PersonalTaskView[]>([]), [taskCursor, setTaskCursor] = useState<number | null>(null);
  const [task, setTask] = useState<PersonalTaskGetResult | null>(null);
  const [timeline, setTimeline] = useState<InvoiceWorkTimelinePage | null>(null);
  const [history, setHistory] = useState<PersonalHistoryPage | null>(null), [historyDetail, setHistoryDetail] = useState<PersonalHistoryEntry | null>(null);
  const [creating, setCreating] = useState(false), [view, setView] = useState<'Invoices' | 'Tasks' | 'History' | 'Timeline'>('Invoices');
  const [decision, setDecision] = useState(''), [loading, setLoading] = useState(false), [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null), [message, setMessage] = useState<string | null>(null);
  const [report, setReport] = useState<string | null>(null), [receiptMissing, setReceiptMissing] = useState(false);
  const generation = useRef(0), itemGeneration = useRef(0), taskGeneration = useRef(0), historyGeneration = useRef(0);
  const operation = useRef(false), goalInput = useRef<HTMLTextAreaElement>(null);

  function persist(change: Partial<PersonalDraft>): boolean {
    const next = { ...draftRef.current, ...change };
    if (!savePersonalDraft(localStorage, next)) { setDraftError('Your draft could not be saved. No command was submitted.'); return false; }
    draftRef.current = next; setDraft(next); setDraftError(null); return true;
  }
  function current(token: number) { return token === generation.current; }
  async function readItem(itemId: number, append = false) {
    const workId = draftRef.current.selectedWorkId; if (workId === null) return;
    const token = ++itemGeneration.current;
    try {
      const page = need(await window.flowmate.invoiceWorks.get({ view: 'item', workId, itemId,
        ...(append && todoCursor !== null ? { afterTodoId: todoCursor } : {}), limit: 50 }));
      if (token !== itemGeneration.current || workId !== draftRef.current.selectedWorkId || page.view !== 'item') return;
      setWork(page.work); setSelectedItem(page.item); setDecision('');
      setTodos(previous => append ? [...previous, ...page.todos] : page.todos); setTodoCursor(page.nextAfterTodoId);
    } catch (cause) { if (token === itemGeneration.current) setError(cause instanceof Error ? cause.message : 'The original invoice could not be read.'); }
  }
  async function readTask(attemptId: number, append = false) {
    const workId = draftRef.current.selectedWorkId; if (workId === null) return;
    const token = ++taskGeneration.current;
    try {
      const result = need(await window.flowmate.personalTasks.get({ workId, attemptId,
        ...(append && task?.nextAfterChildRunId ? { afterChildRunId: task.nextAfterChildRunId } : {}), limit: 50 }));
      if (token !== taskGeneration.current || workId !== draftRef.current.selectedWorkId) return;
      setTask(previous => append && previous?.task.attempt.attemptId === attemptId
        ? { ...result, children: [...previous.children, ...result.children] } : result); setReport(null);
    } catch (cause) { if (token === taskGeneration.current) setError(cause instanceof Error ? cause.message : 'The original task could not be read.'); }
  }
  async function refresh(workId = draftRef.current.selectedWorkId) {
    const token = ++generation.current; setLoading(true); setError(null);
    try {
      const [savedAgent, material] = await Promise.all([window.flowmate.personalAgent.get(), window.flowmate.listDocuments({ limit: 50 })]);
      const assistant = need(savedAgent), docs = need(material);
      const list = need(await window.flowmate.invoiceWorks.list({ personalAgentId: assistant.personalAgentId, limit: 30 }));
      if (!current(token)) return;
      setAgent(assistant); setConfiguration(previous => previous ?? { revision: assistant.revision, value: structuredClone(assistant.configuration) });
      setWorks(list.items); setWorkCursor(list.nextBeforeId); setDocuments(docs.items); setDocumentCursor(docs.nextBeforeId);
      if (workId === null) { setWork(null); setItems([]); setTasks([]); setTask(null); setTimeline(null); return; }
      const [saved, attempts, activity] = await Promise.all([window.flowmate.invoiceWorks.get({ view: 'work', workId, limit: 50 }),
        window.flowmate.personalTasks.list({ workId, limit: 30 }), window.flowmate.invoiceWorks.timeline({ workId, limit: 50 })]);
      const value = need(saved), executions = need(attempts), events = need(activity);
      if (!current(token) || workId !== draftRef.current.selectedWorkId || value.view !== 'work') return;
      setWork(value.work); setItems(value.items); setItemCursor(value.nextAfterItemId); setTasks(executions.items); setTaskCursor(executions.nextBeforeAttemptId); setTimeline(events);
      if (selectedItem?.workId === workId) void readItem(selectedItem.itemId);
      const attemptId = value.work.execution.attempt?.attemptId ?? executions.items[0]?.attempt.attemptId;
      if (attemptId !== undefined) void readTask(attemptId); else setTask(null);
    } catch (cause) { if (current(token)) setError(cause instanceof Error ? cause.message : 'Personal Agent could not be read.'); }
    finally { if (current(token)) setLoading(false); }
  }
  useEffect(() => { if (props.ready) void refresh(); return () => { generation.current++; itemGeneration.current++; taskGeneration.current++; historyGeneration.current++; }; }, [props.ready, props.hostEpoch]);
  useEffect(() => { if (creating) goalInput.current?.focus(); }, [creating]);

  async function operate(action: () => Promise<void>) {
    if (operation.current) return; operation.current = true; setSaving(true); setError(null); setMessage(null);
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'The original operation could not be confirmed.'); }
    finally { operation.current = false; setSaving(false); }
  }
  async function acceptReceipt(receipt: PersonalWriteReceipt) {
    const originalWorkId = draftRef.current.selectedWorkId;
    const supplements = { ...draftRef.current.supplements };
    if ('operation' in receipt && receipt.operation === 'supplement') delete supplements[supplementKey(receipt.workId, receipt.itemId, receipt.todoId)];
    let review = draftRef.current.review;
    if ('operation' in receipt && receipt.operation === 'disposeItem' && receipt.disposition === 'accepted'
      && review?.target.workId === receipt.workId && review.target.itemId === receipt.itemId) review = { ...review, acceptRequest: null };
    if (!persist({ pending: null, selectedWorkId: receipt.workId, supplements, review })) return;
    if (originalWorkId !== receipt.workId) {
      itemGeneration.current++; taskGeneration.current++; historyGeneration.current++;
      setSelectedItem(null); setTodos([]); setTask(null); setHistory(null); setHistoryDetail(null); setReport(null); setView('Invoices');
    }
    setReceiptMissing(false); setMessage(personalReceiptText(receipt)); setCreating(false);
    await refresh(receipt.workId);
  }
  async function submit(raw: unknown) {
    if (draftRef.current.pending || draftError) return;
    const command = capturePersonalWrite(raw); if (!command) throw Error('The invoice command is incomplete or exceeds its size limit.');
    if (!persist({ pending: command })) return;
    const result = await executePersonalWrite(window.flowmate, command);
    if (result.ok) { await acceptReceipt(result.data); return; }
    if (['input_invalid', 'state_conflict', 'source_invalid', 'invoice_work_closed'].includes(result.error.code)) persist({ pending: null });
    setError(result.error.message); setReceiptMissing(false);
  }
  async function recover(retry = false) {
    const original = draftRef.current.pending; if (!original) return;
    const receipt = await recoverPersonalWrite(window.flowmate, original);
    if (!receipt.ok) throw Error(receipt.error.message);
    if (receipt.data) { await acceptReceipt(receipt.data); return; }
    setReceiptMissing(true); setMessage('No saved receipt was found. Your original request and draft are retained.');
    if (retry) { const result = await executePersonalWrite(window.flowmate, original); if (!result.ok) throw Error(result.error.message); await acceptReceipt(result.data); }
  }
  async function selectWork(workId: number) {
    if (!persist({ selectedWorkId: workId })) return;
    itemGeneration.current++; taskGeneration.current++; historyGeneration.current++;
    setSelectedItem(null); setTodos([]); setTask(null); setHistory(null); setHistoryDetail(null); setCreating(false); setReport(null); setMessage(null);
    await refresh(workId);
  }
  async function readHistory(target: PersonalHistoryTarget, append = false) {
    const token = ++historyGeneration.current;
    try {
      const page = need(await window.flowmate.personalTasks.history({ target, limit: 30,
        ...(append && history?.nextBeforeEntryId ? { throughEntryId: history.throughEntryId, beforeEntryId: history.nextBeforeEntryId } : {}) }));
      if (token !== historyGeneration.current || target.workId !== draftRef.current.selectedWorkId) return;
      setHistory(previous => append && previous?.owner.sessionId === page.owner.sessionId ? { ...page, entries: [...previous.entries, ...page.entries] } : page);
      setHistoryDetail(null); setView('History');
    } catch (cause) { if (token === historyGeneration.current) setError(cause instanceof Error ? cause.message : 'Original history could not be read.'); }
  }
  async function readEntry(entryId: number, offset = 0) {
    if (!history) return; const token = ++historyGeneration.current;
    const target = { workId: history.owner.workId, ...(history.owner.childRunId === null ? {} : { childRunId: history.owner.childRunId }) };
    const detail = need(await window.flowmate.personalTasks.historyEntry({ target, entryId, throughEntryId: history.throughEntryId, offset, limit: 8192 }));
    if (token === historyGeneration.current && target.workId === draftRef.current.selectedWorkId) setHistoryDetail(detail);
  }
  async function originalAcceptance(review: NonNullable<PersonalDraft['review']>) {
    if (!review.acceptRequest) throw Error('The original acceptance request is not available.');
    const original = need(await window.flowmate.queryInvoiceCandidateOperation({ kind: 'accept', request: review.acceptRequest }));
    if (!original || !('candidate' in original) || !('job' in original) || original.candidate.status !== 'accepted'
      || original.candidate.candidateId !== review.acceptRequest.candidateId || original.job.jobId !== review.acceptRequest.jobId)
      throw Error('The original acceptance is not confirmed. Review the original invoice before attaching it.');
    return original;
  }
  async function checkAcceptance() {
    const review = draftRef.current.review; if (!review?.acceptRequest) return;
    const token = generation.current;
    await originalAcceptance(review);
    if (!current(token)) return;
    const saved = need(await window.flowmate.invoiceWorks.get({ view: 'item', workId: review.target.workId, itemId: review.target.itemId, limit: 1 }));
    if (!current(token)) return;
    if (saved.view !== 'item' || saved.item.documentRef.id !== review.target.documentRef.id || saved.item.documentRef.version !== review.target.documentRef.version)
      throw Error('The original Work invoice has changed.');
    if (saved.work.status === 'open' && saved.item.disposition === 'unresolved') {
      setMessage('Original acceptance confirmed. Attach it to the unresolved invoice item.'); return;
    }
    const currentReview = draftRef.current.review;
    if (currentReview?.target.workId !== review.target.workId || currentReview.target.itemId !== review.target.itemId
      || currentReview.acceptRequest?.operationRef !== review.acceptRequest.operationRef) return;
    if (persist({ review: null })) setMessage('Original acceptance confirmed. The finished Work review link was released.');
  }
  async function attachAcceptance() {
    const review = draftRef.current.review; if (!review?.acceptRequest || !work || work.workId !== review.target.workId) return;
    const original = await originalAcceptance(review);
    const item = need(await window.flowmate.invoiceWorks.get({ view: 'item', workId: work.workId, itemId: review.target.itemId, limit: 1 }));
    if (item.view !== 'item' || item.item.documentRef.id !== review.target.documentRef.id || item.item.documentRef.version !== review.target.documentRef.version)
      throw Error('The original Work invoice has changed.');
    await submit({ type: 'invoice_work_dispose_item', input: { workId: work.workId, itemId: item.item.itemId,
      requestId: requestId(), expectedRevision: item.work.revision, decision: { kind: 'accepted',
        candidateRef: { id: original.candidate.candidateId, sequence: original.candidate.sequence }, acceptRequest: review.acceptRequest } } });
  }
  const writeDisabled = !props.ready || saving || loading || draft.pending !== null || draftError !== null;
  const eligible = documents.filter(document => !document.isHidden && document.status === 'available');
  const action = (kind: 'continue' | 'stop' | 'cancel') => work?.actions.find(value => value.kind === kind);
  const displayDocument = (id: number) => documents.find(document => document.documentRef.id === id)?.displayName ?? `Invoice ${id}`;
  const selectedItemId = selectedItem?.itemId;

  return <section className="page-content personal-agent-page" aria-label="Personal Agent workspace">
    <header className="page-heading"><div><h1>Personal Agent</h1><p>Keep a selected group of invoices moving toward your explicit review and disposition.</p></div>
      <div className="button-row"><button type="button" className="text-button" disabled={!props.ready || saving} onClick={() => void refresh()}>Refresh saved work</button>
        <button type="button" className="primary-button" disabled={writeDisabled || !agent} onClick={() => { if (persist({ source: undefined })) setCreating(true); setError(null); }}>New invoice work</button></div></header>
    {!props.ready && <p role="status" className="notice">The runtime is not connected. Saved drafts are retained.</p>}
    {draftError && <section className="notice bad"><p role="alert">{draftError}</p><button type="button" onClick={() => persist(emptyPersonalDraft())}>Discard unreadable local draft</button></section>}
    {error && <p role="alert" className="notice bad">{error}</p>}{message && <p role="status" className="notice">{message}</p>}
    {loading && <p role="status">Loading saved Personal Agent facts…</p>}
    {draft.pending && <section className="panel personal-pending" aria-label="Original request recovery"><h2>Original request awaiting confirmation</h2>
      <p>Your saved {title(draft.pending.type)} request is retained. Checking its receipt does not execute it again.</p>
      <div className="button-row"><button type="button" disabled={!props.ready || saving} onClick={() => void operate(() => recover())}>Check saved receipt</button>
        {receiptMissing && <button type="button" disabled={!props.ready || saving} onClick={() => void operate(() => recover(true))}>Retry original request</button>}</div></section>}
    <PersonalConfiguration ready={props.ready} hostEpoch={props.hostEpoch} disabled={writeDisabled} models={props.models} configuration={configuration}
      onModels={props.onModels} onChange={value => { if (configuration) setConfiguration({ ...configuration, value }); }} onSave={() => void operate(async () => {
        if (!configuration) return;
        if (!agent) return; const saved = need(await window.flowmate.personalAgent.update({ personalAgentId: agent.personalAgentId,
          expectedRevision: configuration.revision, configuration: configuration.value }));
        setAgent(saved); setConfiguration({ revision: saved.revision, value: structuredClone(saved.configuration) }); setMessage('Assistant configuration saved. Existing work keeps its accepted configuration.');
      })} onReload={() => void operate(async () => { const saved = need(await window.flowmate.personalAgent.get()); setAgent(saved); setConfiguration({ revision: saved.revision, value: structuredClone(saved.configuration) }); })} />
    {creating && agent ? <form className="panel personal-create" onSubmit={event => { event.preventDefault(); void operate(() => submit({ type: 'invoice_work_create', input: {
      personalAgentId: agent.personalAgentId, expectedAgentRevision: agent.revision, requestId: requestId(), goal: draft.goal,
      documents: draft.documents, ...(draft.source ? { source: { ...draft.source, items: draft.source.items.filter(item => draft.documents.some(ref => ref.id === item.documentRef.id && ref.version === item.documentRef.version)) } } : {}) } })); }}>
      <h2>{draft.source ? 'Create related invoice work' : 'New invoice work'}</h2><label className="field"><span id="personal-work-goal-label">Invoice work goal</span>
        <textarea ref={goalInput} aria-labelledby="personal-work-goal-label" required maxLength={22000} value={draft.goal} onChange={event => persist({ goal: event.target.value })} /></label>
      <p>The selected invoices are fixed when submitted. Each invoice still needs an explicit final disposition.</p>
      {draft.source && <p>Related to Work {draft.source.workId}; original dispositions and permissions are not inherited.</p>}
      <fieldset disabled={writeDisabled}><legend>Parsed invoices · {draft.documents.length} selected</legend>
        {eligible.map(document => <label key={document.documentRef.id} className="personal-document-option"><input type="checkbox"
          checked={draft.documents.some(ref => ref.id === document.documentRef.id)} onChange={event => persist({ documents: event.target.checked
            ? [...draft.documents.filter(ref => ref.id !== document.documentRef.id), document.documentRef] : draft.documents.filter(ref => ref.id !== document.documentRef.id) })} />
          {document.displayName}<small>Version {document.documentRef.version}</small></label>)}
        {!eligible.length && <p>No available parsed invoices. Import and parse invoices in Invoices first.</p>}</fieldset>
      {documentCursor && <button type="button" disabled={loading || saving} onClick={() => void operate(async () => { const token = generation.current; const page = need(await window.flowmate.listDocuments({ beforeId: documentCursor, limit: 50 })); if (!current(token)) return; setDocuments(previous => [...previous, ...page.items]); setDocumentCursor(page.nextBeforeId); })}>More parsed invoices</button>}
      <div className="button-row"><button type="submit" className="primary-button" disabled={writeDisabled || !draft.goal.trim() || draft.documents.length === 0}>Submit invoice work</button>
        <button type="button" disabled={saving} onClick={() => setCreating(false)}>Keep draft and close</button></div></form> : null}
    <div className="personal-layout">
      <aside className="panel personal-work-list" aria-label="Invoice work list"><h2>Saved work</h2>
        {!works.length && !loading && <p>No invoice work yet.</p>}{works.map(value => <button type="button" key={value.workId} className={work?.workId === value.workId ? 'active' : ''} aria-label={`Open Work ${value.workId}: ${value.goal}`}
          aria-current={work?.workId === value.workId ? 'true' : undefined} onClick={() => void selectWork(value.workId)}><strong>{value.goal}</strong>
          <span>Work {value.workId} · {value.status} · {value.counts.total - value.counts.unresolved}/{value.counts.total} disposed</span></button>)}
        {workCursor && agent && <button type="button" disabled={loading || saving} onClick={() => void operate(async () => { const token = generation.current; const page = need(await window.flowmate.invoiceWorks.list({ personalAgentId: agent.personalAgentId, beforeId: workCursor, limit: 30 })); if (!current(token)) return; setWorks(previous => [...previous, ...page.items]); setWorkCursor(page.nextBeforeId); })}>Earlier invoice work</button>}
      </aside>
      <div className="panel personal-work-detail" aria-busy={loading}>
        {!work ? <p>Select saved work or explicitly submit a new invoice work.</p> : <>
          <header><h2>Work {work.workId}</h2><p>{work.goal}</p><p><strong>{work.status}</strong> · {work.counts.accepted} accepted · {work.counts.rejected} rejected · {work.counts.excluded} excluded · {work.counts.unresolved} unresolved</p></header>
          <p>Attempt {work.execution.attempt?.attemptId ?? 'not created'} · {work.execution.runStatus ?? (work.execution.queued ? 'queued' : 'no Run')} · {work.execution.ownedChildRunIds.length} owned child executions</p>
          {work.execution.waitingReason && <p role="status">{work.execution.waitingReason}</p>}
          {work.execution.requiresContinue && <p>Execution was stopped or failed. Supplements are saved; explicitly continue to authorize further execution.</p>}
          {work.execution.stopUnconfirmed && <p role="status">Actual stop is not confirmed. Original ownership and results are retained.</p>}
          <div className="button-row">
            <button type="button" disabled={writeDisabled || !action('continue')?.enabled} title={action('continue')?.reason ?? undefined} onClick={() => void operate(() => submit({ type: 'invoice_work_continue', input: { workId: work.workId, expectedRevision: work.revision, expectedAttemptId: work.execution.attempt?.attemptId ?? null, requestId: requestId() } }))}>Continue work</button>
            <button type="button" disabled={writeDisabled || !action('stop')?.enabled || !work.execution.attempt} title={action('stop')?.reason ?? undefined} onClick={() => void operate(() => submit({ type: 'personal_task_stop', input: { workId: work.workId, attemptId: work.execution.attempt!.attemptId, expectedRevision: work.revision, requestId: requestId() } }))}>Stop current attempt</button>
            <button type="button" disabled={writeDisabled || !action('cancel')?.enabled} title={action('cancel')?.reason ?? undefined} onClick={() => void operate(() => submit({ type: 'invoice_work_cancel', input: { workId: work.workId, expectedRevision: work.revision, requestId: requestId() } }))}>Cancel entire work</button>
            {work.status !== 'open' && <button type="button" disabled={writeDisabled} onClick={() => { if (persist({ goal: work.goal, documents: items.map(item => item.documentRef),
              source: { workId: work.workId, items: items.map(item => ({ itemId: item.itemId, documentRef: item.documentRef, candidateRef: item.candidateRef })) } })) setCreating(true); }}>Create related work</button>}
          </div>
          <div className="tabs" role="tablist" aria-label="Personal Agent views">{(['Invoices', 'Tasks', 'History', 'Timeline'] as const).map(tab => <button type="button" key={tab} role="tab" aria-selected={view === tab}
            onClick={() => { setView(tab); if (tab === 'History') void readHistory({ workId: work.workId }); }}>{tab}</button>)}</div>
          {view === 'Invoices' && <>
            <ul className="personal-items">{items.map(item => <li key={item.itemId}><button type="button" aria-pressed={selectedItemId === item.itemId} onClick={() => void readItem(item.itemId)}>
              {displayDocument(item.documentRef.id)} · {item.disposition} · {item.todoCount} Todo</button><span>Candidate {item.candidateRef ? `${item.candidateRef.id}/${item.candidateRef.sequence}` : 'not saved'}</span></li>)}</ul>
            {itemCursor && <button type="button" onClick={() => void operate(async () => { const token = generation.current; const page = need(await window.flowmate.invoiceWorks.get({ view: 'work', workId: work.workId, afterItemId: itemCursor, limit: 50 })); if (current(token) && draftRef.current.selectedWorkId === work.workId && page.view === 'work') { setItems(previous => [...previous, ...page.items]); setWork(page.work); setItemCursor(page.nextAfterItemId); } })}>More work invoices</button>}
            {selectedItem && <section className="personal-item-detail" aria-label="Selected Work invoice"><h3>{displayDocument(selectedItem.documentRef.id)}</h3><p>Invoice item {selectedItem.itemId} · version {selectedItem.documentRef.version} · {selectedItem.disposition}</p>
              <button type="button" disabled={!props.ready || saving} onClick={() => void operate(() => props.onOpenInvoice({ workId: work.workId, itemId: selectedItem.itemId,
                documentRef: selectedItem.documentRef, jobId: selectedItem.jobId, candidateRef: selectedItem.candidateRef }))}>View original invoice / review</button>
              {todos.map(todo => { const key = supplementKey(work.workId, selectedItem.itemId, todo.todoId), value = draft.supplements[key] ?? { text: '', materials: [] };
                return <article key={todo.todoId} className="personal-todo"><h4>{todo.fieldPath ?? 'Invoice review'} · {todo.actor} · {todo.action}</h4><p>{todo.problem}</p><p>Needed: {todo.needed}</p><p>Satisfied by: {todo.satisfiedBy}</p>
                  <p>Basis: {todo.basis.origin}; {todo.basis.documentRefs.map(ref => `${ref.id}/${ref.version}`).join(', ')}{todo.basis.candidateRef ? `; candidate ${todo.basis.candidateRef.id}/${todo.basis.candidateRef.sequence}` : ''}</p>
                  {todo.basis.sourceRefs.length > 0 && <p>Source locations: {todo.basis.sourceRefs.map(source => `page ${source.page}, ${source.blockId ?? 'page'}, version ${source.version}`).join('; ')}</p>}
                  {todo.applicable && todo.actor === 'user' && <form onSubmit={event => { event.preventDefault(); void operate(() => submit({ type: 'invoice_work_supplement', input: { workId: work.workId, itemId: selectedItem.itemId, todoId: todo.todoId,
                    expectedRevision: work.revision, requestId: requestId(), text: value.text, materials: value.materials } })); }}>
                    <label className="field"><span>Supplement for Todo {todo.todoId}</span><textarea maxLength={22000} value={value.text} disabled={writeDisabled || work.status !== 'open'} onChange={event => persist({ supplements: { ...draftRef.current.supplements, [key]: { ...value, text: event.target.value } } })} /></label>
                    <fieldset disabled={writeDisabled || work.status !== 'open'}><legend>Additional authorized material</legend>{eligible.map(document => <label className="personal-document-option" key={document.documentRef.id}><input type="checkbox" checked={value.materials.some(ref => ref.id === document.documentRef.id)} onChange={event => persist({ supplements: { ...draftRef.current.supplements, [key]: { ...value, materials: event.target.checked ? [...value.materials, document.documentRef] : value.materials.filter(ref => ref.id !== document.documentRef.id) } } })} />{document.displayName}</label>)}</fieldset>
                    <p>Saving automatically continues this invoice when eligible. After a stopped or failed attempt, it only saves the supplement; Continue work is required.</p>
                    <button type="submit" disabled={writeDisabled || work.status !== 'open' || !value.text.trim() && value.materials.length === 0}>Save supplement for Todo {todo.todoId}</button></form>}
                </article>; })}
              {todoCursor && <button type="button" onClick={() => void readItem(selectedItem.itemId, true)}>More invoice Todo</button>}
              {selectedItem.disposition === 'unresolved' && work.status === 'open' && <fieldset disabled={writeDisabled}><legend>Explicit final disposition</legend>
                <p>Rejecting a candidate in Invoices does not end this item. These actions end this Work's processing of this invoice.</p>
                <label className="field"><span>Disposition reason</span><input maxLength={2048} value={decision} onChange={event => setDecision(event.target.value)} /></label>
                {(['rejected', 'excluded'] as const).map(kind => <button key={kind} type="button" disabled={!decision.trim()} onClick={() => void operate(() => submit({ type: 'invoice_work_dispose_item', input: { workId: work.workId, itemId: selectedItem.itemId,
                  expectedRevision: work.revision, requestId: requestId(), decision: { kind, reason: decision } } }))}>{kind === 'rejected' ? 'End processing as rejected' : 'Exclude invoice from this work'}</button>)}
              </fieldset>}
            </section>}
            {draft.review?.acceptRequest && draft.review.target.workId === work.workId && <section className="notice"><p>Original acceptance retained for invoice item {draft.review.target.itemId}. A finished Work or item can release its review link only after the original receipt is confirmed.</p>
              <button type="button" disabled={writeDisabled} onClick={() => void operate(checkAcceptance)}>Check original acceptance</button>
              {work.status === 'open' && <button type="button" disabled={writeDisabled} onClick={() => void operate(attachAcceptance)}>Attach confirmed acceptance</button>}</section>}
          </>}
          {view === 'Tasks' && <section aria-label="Work execution attempts"><h3>Execution attempts</h3>{tasks.map(value => <button type="button" key={value.attempt.attemptId} onClick={() => void readTask(value.attempt.attemptId)}>Attempt {value.attempt.attemptId} · {value.runStatus ?? 'not started'}{value.queued ? ' · queued' : ''}</button>)}
            {taskCursor && <button type="button" onClick={() => void operate(async () => { const token = generation.current; const page = need(await window.flowmate.personalTasks.list({ workId: work.workId, beforeAttemptId: taskCursor, limit: 30 })); if (!current(token) || draftRef.current.selectedWorkId !== work.workId) return; setTasks(previous => [...previous, ...page.items]); setTaskCursor(page.nextBeforeAttemptId); })}>Earlier attempts</button>}
            {task && <><p>Attempt {task.task.attempt.attemptId}: {task.task.runStatus ?? 'no Run'} · stop {task.task.stoppedAt ? 'confirmed' : 'not confirmed'}</p>{task.children.length === 0 && <p>No saved child execution for this attempt.</p>}
              {task.children.map(child => <article className="personal-child" key={child.childRunId}><h4>Evidence checker {child.childRunId}</h4><p>{child.runStatus} · report {child.resultRecorded ? 'saved' : 'not confirmed'} · returned to Master {child.delivery.messageObservedAt ? 'observed' : 'not confirmed'} · Master received {child.parentModelReceivedAt ?? 'not confirmed'} · stop {child.stopConfirmed ? 'confirmed' : 'not confirmed'}</p>
                <p>Report delivery and source references do not prove that its conclusions are correct.</p><div className="button-row"><button type="button" onClick={() => void readHistory({ workId: work.workId, childRunId: child.childRunId })}>View child history {child.childRunId}</button>
                  <button type="button" onClick={() => void operate(async () => { const token = taskGeneration.current; const run = need(await window.flowmate.queryRun(child.childRunId));
                    if (run.runId !== child.childRunId || run.kind !== 'subagent' || !('runtimeKind' in run) || run.runtimeKind !== 'durable'
                      || run.scope.workId !== work.workId || run.scope.attemptId !== task.task.attempt.attemptId || run.originToolCallId !== child.originToolCallId)
                      throw Error('The child report does not belong to the selected original execution.');
                    if (token === taskGeneration.current && draftRef.current.selectedWorkId === work.workId) setReport(JSON.stringify(run.output, null, 2)); })}>Read child report {child.childRunId}</button></div></article>)}
              {task.nextAfterChildRunId && <button type="button" onClick={() => void readTask(task.task.attempt.attemptId, true)}>More child results</button>}{report && <pre>{report}</pre>}</>}
          </section>}
          {view === 'History' && <section aria-label="Durable history"><div className="button-row"><h3>{history?.owner.childRunId ? `Child ${history.owner.childRunId} history` : 'Work history'}</h3><button type="button" onClick={() => void readHistory({ workId: work.workId })}>Read work history</button></div>
            {!history ? <p>Select the saved history to read.</p> : <><p>Saved Entry watermark {history.throughEntryId}. History queries do not resume execution.</p>{history.entries.length === 0 && <p>No native history has been created for this target.</p>}
              {history.entries.map(entry => <article key={entry.entryId}><button type="button" onClick={() => void operate(() => readEntry(entry.entryId))}>Entry {entry.entryId} · {entry.kind} · {entry.role ?? 'metadata'}</button><p>{entry.createdAt ?? 'No recorded timestamp'} · {entry.byteLength} bytes</p><pre>{entry.preview.text}{entry.preview.truncated ? '…' : ''}</pre></article>)}
              {history.nextBeforeEntryId && <button type="button" onClick={() => void readHistory({ workId: history.owner.workId, ...(history.owner.childRunId === null ? {} : { childRunId: history.owner.childRunId }) }, true)}>Earlier history entries</button>}
              {historyDetail && <section className="personal-history-detail"><h4>Original Entry {historyDetail.entryId}</h4><p>{historyDetail.format} · bytes {historyDetail.offset}–{historyDetail.offset + new TextEncoder().encode(historyDetail.text).byteLength} of {historyDetail.totalBytes}</p><pre>{historyDetail.text}</pre>{historyDetail.nextOffset !== null && <button type="button" onClick={() => void operate(() => readEntry(historyDetail.entryId, historyDetail.nextOffset!))}>Next Entry chunk</button>}</section>}</>}
          </section>}
          {view === 'Timeline' && <section aria-label="Work evidence timeline"><h3>Saved business timeline</h3><p>Activity comes from saved records. Refresh to see late evidence; a finished evidence checker does not accept an invoice.</p>
            {timeline?.entries.map(entry => <article key={entry.key}><h4>{title(entry.kind)}</h4><p>{entry.summary}</p><small>{entry.occurredAt} · {entry.itemId === null ? 'Work' : `Invoice item ${entry.itemId}`}</small>
              {entry.refs.candidateRef && <p>Result {entry.refs.candidateRef.id} · version {entry.refs.candidateRef.sequence}</p>}
              {entry.refs.documentRef && <p>Invoice {entry.refs.documentRef.id} · source version {entry.refs.documentRef.version}</p>}
              <details><summary>Original references</summary><pre>{JSON.stringify(entry.refs, null, 2)}</pre></details>
              {entry.evidence.resultRecorded && <p>Result saved{entry.refs.childRunId !== undefined ? ` · returned to Master ${entry.evidence.returnedToParent ? 'observed' : 'not confirmed'} · Master received ${entry.evidence.parentConsumed ? 'observed' : 'not confirmed'}` : ''}</p>}
              {entry.refs.childReportRefs?.map(reference => <p key={`${reference.childRunId}:${reference.fieldPath}`}>
                Master cited child {reference.childRunId} for {reference.fieldPath}; {reference.sourceRefs.length} source locations, {reference.inputIds.length} inputs.
                {' '}This records the cited conclusion; it does not verify its meaning.
                <button type="button" onClick={() => void readHistory({ workId: work.workId, childRunId: reference.childRunId })}>Read cited child {reference.childRunId}</button>
              </p>)}
              {entry.evidence.stopConfirmed && <p>Execution stop confirmed.</p>}</article>)}
            {timeline?.nextBefore && <button type="button" onClick={() => void operate(async () => { const token = generation.current; const page = need(await window.flowmate.invoiceWorks.timeline({ workId: work.workId, before: timeline.nextBefore!, limit: 50 }));
              if (!current(token) || draftRef.current.selectedWorkId !== work.workId) return;
              setTimeline(previous => ({ ...page, entries: [...new Map([...(previous?.entries ?? []), ...page.entries].map(entry => [entry.key, entry])).values()].sort((a, b) => compareInvoiceWorkTimelineCursor(b, a)) })); })}>Earlier timeline facts</button>}
          </section>}
        </>}
      </div>
    </div>
  </section>;
}
