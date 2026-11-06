import { useEffect, useRef, useState } from 'react';
import { CloudReviewAcceptReceiptSchema, CloudReviewCandidateReceiptSchema, CloudReviewOpenReceiptSchema, CloudReviewOriginalReceiptSchema,
  CloudReviewPageReceiptSchema, CloudReviewRejectReceiptSchema, CloudReviewSaveReceiptSchema, invoiceHeaderFields, invoiceLineFields,
  type AcceptInvoiceCandidateRequest, type CloudDesktopUserCommand, type InvoiceFormDraft } from '@flowmate/contracts';
import { mapInvoiceCandidate } from './invoice-form.ts';
import { clearCloudReviewDraft, readCloudReviewDraft, saveCloudReviewDraft, type CloudReviewDraft } from './cloud-review-state.ts';
import type { PersonalReviewTarget } from './personal-state.ts';

type Props = { workspaceId: string; target: PersonalReviewTarget; onClose(): void;
  onAcceptancePrepared(target: PersonalReviewTarget, request: AcceptInvoiceCandidateRequest): boolean };
type Candidate = ReturnType<typeof CloudReviewCandidateReceiptSchema.parse>;
type Original = ReturnType<typeof CloudReviewOriginalReceiptSchema.parse>;
type Page = ReturnType<typeof CloudReviewPageReceiptSchema.parse>['page'];

function sameTarget(a: PersonalReviewTarget, b: PersonalReviewTarget): boolean {
  return a.workId === b.workId && a.itemId === b.itemId && a.documentRef.id === b.documentRef.id
    && a.documentRef.version === b.documentRef.version && a.jobId === b.jobId
    && a.candidateRef?.id === b.candidateRef?.id && a.candidateRef?.sequence === b.candidateRef?.sequence;
}
function dirty(draft: CloudReviewDraft): boolean {
  return JSON.stringify(draft.draft) !== JSON.stringify(draft.baseline)
    || JSON.stringify(draft.lineOrigins) !== JSON.stringify(draft.baselineLineOrigins);
}

export function CloudInvoiceReview(props: Props) {
  const [initial] = useState(() => readCloudReviewDraft(localStorage, props.workspaceId));
  const [draft, setDraft] = useState<CloudReviewDraft | null>(initial.ok ? initial.data : null), draftRef = useRef(draft);
  const [candidate, setCandidate] = useState<Candidate | null>(null), [original, setOriginal] = useState<Original | null>(null);
  const [page, setPage] = useState<Page | null>(null), [imageError, setImageError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(initial.ok ? null : initial.error.message), [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [retryReady, setRetryReady] = useState(false);
  const generation = useRef(0), operation = useRef(false);
  const target = props.target, matched = draft !== null && sameTarget(draft.target, target);
  const current = matched ? draft : null;
  const base = { workId: target.workId, itemId: target.itemId, documentRef: target.documentRef };

  function persist(value: CloudReviewDraft): boolean {
    if (!saveCloudReviewDraft(localStorage, props.workspaceId, value)) { setError('The cloud review draft could not be saved. No new operation was sent.'); return false; }
    draftRef.current = value; setDraft(value); return true;
  }
  async function request(command: CloudDesktopUserCommand): Promise<unknown> {
    const result = await window.flowmate.cloudDesktop.request({ workspaceId: props.workspaceId, command });
    if (!result.ok) throw Error(result.error.message);
    return result.data;
  }
  async function loadPage(number: number, afterBlockId: string | null = null) {
    const token = generation.current;
    const receipt = CloudReviewPageReceiptSchema.parse(await request({ type: 'cloud_review_page', input: { ...base, page: number, afterBlockId, limit: 50 } }));
    if (token !== generation.current) return;
    setPage(previous => afterBlockId && previous?.page === number ? { ...receipt.page, blocks: [...previous.blocks, ...receipt.page.blocks] } : receipt.page);
  }
  async function loadCandidate(candidateId: number, existing: CloudReviewDraft | null) {
    if (target.jobId === null || target.candidateRef === null) return;
    const token = generation.current;
    const receipt = CloudReviewCandidateReceiptSchema.parse(await request({ type: 'cloud_review_candidate',
      input: { ...base, jobId: target.jobId, candidateId } }));
    if (token !== generation.current) return;
    if (existing && receipt.detail.sequence !== existing.sequence) throw Error('The original candidate version changed.');
    setCandidate(receipt);
    if (initial.ok && !existing && !draftRef.current) {
      const mapped = mapInvoiceCandidate(receipt.detail.candidate);
      if (!mapped) throw Error('The original candidate cannot be mapped for review.');
      const origins = mapped.draft.lines.map((_, index) => index);
      persist({ version: 1, target, candidateId, sequence: receipt.detail.sequence, workspaceRevision: null,
        draft: mapped.draft, lineOrigins: origins, baseline: structuredClone(mapped.draft), baselineLineOrigins: [...origins], pending: null });
    }
  }
  useEffect(() => {
    const token = ++generation.current;
    void request({ type: 'cloud_review_original', input: { ...base, page: 1 } }).then(value => {
      if (token === generation.current) setOriginal(CloudReviewOriginalReceiptSchema.parse(value));
    }).catch(cause => { if (token === generation.current) setImageError(cause instanceof Error ? cause.message : 'Original image is unavailable.'); });
    void loadPage(1).catch(cause => { if (token === generation.current) setError(cause instanceof Error ? cause.message : 'Parsed page is unavailable.'); });
    const saved = draftRef.current, existing = saved && sameTarget(saved.target, target) ? saved : null;
    if (target.candidateRef) void loadCandidate(existing?.candidateId ?? target.candidateRef.id, existing)
      .catch(cause => { if (token === generation.current) setError(cause instanceof Error ? cause.message : 'The original candidate is unavailable.'); });
    return () => { generation.current++; };
  }, [props.workspaceId, target.workId, target.itemId, target.documentRef.id, target.documentRef.version, target.jobId, target.candidateRef?.id, target.candidateRef?.sequence]);

  async function run(action: () => Promise<void>) {
    if (operation.current) return;
    operation.current = true; setBusy(true); setError(null); setMessage(null);
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'The original cloud review could not be confirmed.'); }
    finally { operation.current = false; setBusy(false); }
  }
  async function prepare() {
    const saved = draftRef.current; if (!saved || !sameTarget(saved.target, target) || target.jobId === null || saved.pending) return;
    const opened = CloudReviewOpenReceiptSchema.parse(await request({ type: 'cloud_review_open',
      input: { ...base, jobId: target.jobId, candidateId: saved.candidateId } }));
    if (opened.sequence !== saved.sequence) throw Error('The original candidate version changed.');
    if (persist({ ...saved, workspaceRevision: opened.workspaceRevision })) setMessage('The original candidate is ready for review.');
  }
  async function received(value: unknown, saved: CloudReviewDraft) {
    const pending = saved.pending; if (!pending) return;
    if (pending.type === 'cloud_review_save') {
      const receipt = CloudReviewSaveReceiptSchema.parse(value), origins = saved.draft.lines.map((_, index) => index);
      const next: CloudReviewDraft = { ...saved, candidateId: receipt.candidateId, sequence: receipt.sequence, workspaceRevision: null,
        baseline: structuredClone(saved.draft), baselineLineOrigins: origins, lineOrigins: origins, pending: null };
      if (!persist(next)) return;
      await loadCandidate(next.candidateId, next); setMessage(receipt.changed ? 'The user-edited candidate was saved.' : 'The candidate was unchanged.');
    } else if (pending.type === 'cloud_review_accept') {
      CloudReviewAcceptReceiptSchema.parse(value);
      if (persist({ ...saved, workspaceRevision: null, pending: null })) props.onClose();
    } else {
      CloudReviewRejectReceiptSchema.parse(value);
      if (persist({ ...saved, workspaceRevision: null, pending: null })) props.onClose();
    }
  }
  async function send(saved: CloudReviewDraft) {
    const pending = saved.pending; if (!pending) return;
    if (pending.type === 'cloud_review_accept' && !props.onAcceptancePrepared(target, pending.input.request))
      throw Error('The original acceptance request could not be saved. No acceptance was sent.');
    const value = await request(pending);
    await received(value, saved);
  }
  async function start(kind: 'save' | 'accept' | 'reject', reason = '') {
    const saved = draftRef.current; if (!saved || !sameTarget(saved.target, target) || saved.pending || saved.workspaceRevision === null || target.jobId === null) return;
    const common = { operationRef: crypto.randomUUID(), jobId: target.jobId, expectedCandidateId: saved.candidateId, expectedRevision: saved.workspaceRevision };
    const pending: NonNullable<CloudReviewDraft['pending']> = kind === 'save'
      ? { type: 'cloud_review_save', input: { ...base, request: { ...common, basedOnCandidateId: saved.candidateId,
        draft: saved.draft, lineOrigins: saved.lineOrigins } } }
      : kind === 'accept' ? { type: 'cloud_review_accept', input: { ...base, request: { ...common, candidateId: saved.candidateId, dirty: false } } }
      : { type: 'cloud_review_reject', input: { ...base, request: { ...common, candidateId: saved.candidateId, reason } } };
    const next = { ...saved, pending }; if (!persist(next)) return;
    setRetryReady(false); await send(next);
  }
  async function recover(retry = false) {
    const saved = draftRef.current, pending = saved?.pending; if (!saved || !pending || !sameTarget(saved.target, target)) return;
    const command: CloudDesktopUserCommand = pending.type === 'cloud_review_save' ? { type: 'cloud_review_query_save', input: pending.input }
      : pending.type === 'cloud_review_accept' ? { type: 'cloud_review_query_accept', input: pending.input }
      : { type: 'cloud_review_query_reject', input: pending.input };
    const receipt = await request(command);
    if (receipt !== null) { await received(receipt, saved); return; }
    setRetryReady(true); setMessage('No saved receipt was found. The original request and draft remain available.');
    if (retry) await send(saved);
  }
  function change(next: InvoiceFormDraft, lineOrigins = current?.lineOrigins ?? []) {
    if (current && !current.pending) persist({ ...current, draft: next, lineOrigins });
  }

  return <section className="page-content" aria-label="Cloud invoice review">
    <header className="page-heading"><div><h1>Cloud invoice review</h1><p>Work {target.workId} · invoice item {target.itemId} · version {target.documentRef.version}</p></div>
      <button type="button" disabled={busy} onClick={props.onClose}>Return to cloud work</button></header>
    {error && <p role="alert" className="notice bad">{error}</p>}{message && <p role="status" className="notice">{message}</p>}
    {!initial.ok && <button type="button" onClick={() => { if (clearCloudReviewDraft(localStorage, props.workspaceId)) props.onClose();
      else setError('The unreadable review draft could not be cleared.'); }}>Discard unreadable review draft</button>}
    {draft && !matched && <section className="notice bad"><p>A saved review for Work {draft.target.workId}, invoice item {draft.target.itemId} is retained.</p>
      {!draft.pending && <button type="button" onClick={() => { if (clearCloudReviewDraft(localStorage, props.workspaceId)) { draftRef.current = null; setDraft(null); props.onClose(); }
        else setError('The saved review draft could not be cleared.'); }}>Discard that saved review draft</button>}</section>}
    <section className="panel"><h2>Original invoice</h2>
      {original ? <img alt="Original cloud invoice" src={`data:${original.mimeType};base64,${original.base64}`} /> : <p>{imageError ?? 'Loading original image…'}</p>}
      <h3>Parsed page</h3>{page && <><label className="field"><span>Page</span><select value={page.page} disabled={busy}
        onChange={event => void run(() => loadPage(Number(event.target.value)))}>{Array.from({ length: page.pageCount }, (_, index) =>
          <option key={index + 1} value={index + 1}>{index + 1}</option>)}</select></label>
        {page.blocks.map(block => <article key={block.id}><strong>{block.id}</strong><p>{block.text}</p></article>)}
        {page.nextAfterBlockId && <button type="button" disabled={busy} onClick={() => void run(() => loadPage(page.page, page.nextAfterBlockId))}>More page blocks</button>}</>}
    </section>
    {target.jobId === null || target.candidateRef === null ? <p>No saved candidate is available for this invoice yet.</p> : candidate && current && <section className="panel">
      <h2>Candidate {candidate.detail.sequence} · {candidate.status}</h2>
      {current.pending ? <div className="notice"><p>The original {current.pending.type.replaceAll('_', ' ')} request is awaiting confirmation.</p>
        <button type="button" disabled={busy} onClick={() => void run(() => recover())}>Check original receipt</button>
        {retryReady && <button type="button" disabled={busy} onClick={() => void run(() => recover(true))}>Retry original request</button>}</div> : <>
        <button type="button" disabled={busy} onClick={() => void run(prepare)}>Prepare candidate review</button>
        {current.workspaceRevision !== null && <p>Review workspace revision {current.workspaceRevision}. Another review may require preparing again.</p>}
      </>}
      <fieldset disabled={busy || !!current.pending}><legend>Invoice fields</legend>{invoiceHeaderFields.map(name => <div key={name}><label className="field"><span>{name}</span>
        <input maxLength={1024} value={current.draft.fields[name]} onChange={event => change({ ...current.draft,
          fields: { ...current.draft.fields, [name]: event.target.value } })} /></label>
        <details><summary>Original field evidence</summary><p>Origin: {candidate.detail.candidate.fields[name].valueOrigin ?? 'document'}</p>
          {candidate.detail.candidate.fields[name].sources.map((source, index) => <p key={index}>Page {source.page} · {source.blockId ?? 'page'} · {source.quote ?? 'no quote'}</p>)}</details></div>)}</fieldset>
      <fieldset disabled={busy || !!current.pending}><legend>Line items</legend>{current.draft.lines.map((line, index) => <section key={index}><h3>Line {index + 1}</h3>
        {invoiceLineFields.map(name => <label className="field" key={name}><span>{name}</span><input maxLength={1024} value={line[name]} onChange={event => {
          const lines = current.draft.lines.map((value, row) => row === index ? { ...value, [name]: event.target.value } : value); change({ ...current.draft, lines }); }} /></label>)}
        <button type="button" onClick={() => change({ ...current.draft, lines: current.draft.lines.filter((_, row) => row !== index) },
          current.lineOrigins.filter((_, row) => row !== index))}>Remove line {index + 1}</button></section>)}
        <button type="button" onClick={() => { const line = Object.fromEntries(invoiceLineFields.map(name => [name, ''])) as InvoiceFormDraft['lines'][number];
          change({ ...current.draft, lines: [...current.draft.lines, line] }, [...current.lineOrigins, null]); }}>Add line</button></fieldset>
      <fieldset disabled={busy || !!current.pending}><legend>Notes</legend>{current.draft.notes.map((note, index) => <label className="field" key={index}><span>Note {index + 1}</span>
        <input maxLength={1024} value={note} onChange={event => change({ ...current.draft, notes: current.draft.notes.map((value, row) => row === index ? event.target.value : value) })} />
        <button type="button" onClick={() => change({ ...current.draft, notes: current.draft.notes.filter((_, row) => row !== index) })}>Remove note</button></label>)}
        <button type="button" onClick={() => change({ ...current.draft, notes: [...current.draft.notes, ''] })}>Add note</button></fieldset>
      {candidate.detail.issues.map((issue, index) => <p key={index}>{issue.severity} · {issue.message}</p>)}
      <div className="button-row"><button type="button" disabled={busy || !!current.pending || current.workspaceRevision === null || !dirty(current)}
        onClick={() => void run(() => start('save'))}>Save edited candidate</button>
        <button type="button" disabled={busy || !!current.pending || current.workspaceRevision === null || dirty(current)}
          onClick={() => void run(() => start('accept'))}>Accept candidate</button></div>
      <RejectCandidate disabled={busy || !!current.pending || current.workspaceRevision === null || dirty(current)} onReject={reason => void run(() => start('reject', reason))} />
    </section>}
  </section>;
}

function RejectCandidate(props: { disabled: boolean; onReject(reason: string): void }) {
  const [reason, setReason] = useState('');
  return <form onSubmit={event => { event.preventDefault(); props.onReject(reason); }}><label className="field"><span>Candidate rejection reason</span>
    <input maxLength={256} value={reason} disabled={props.disabled} onChange={event => setReason(event.target.value)} /></label>
    <button type="submit" disabled={props.disabled || !reason.trim()}>Reject candidate</button></form>;
}
