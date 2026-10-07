import type { ReactNode } from 'react';
import { invoiceHeaderFields, invoiceLineFields } from '../../../../packages/contracts/src/invoice.ts';
import type { CandidateJobDetail, DocumentOriginalImage, DocumentSnapshot, StoredInvoiceField, InvoiceIssue, InvoiceToolOutput,
  JobSnapshot, SourceRef, WorkspaceSelection, WorkspaceSnapshot, WorkspaceView } from '@flowmate/contracts';
import { selectionLabel, sameWorkspaceSelection, type WorkspaceState } from './workspace-state.ts';

const labels: Record<typeof invoiceHeaderFields[number] | typeof invoiceLineFields[number], string> = {
  invoiceNumber: 'Invoice number', issueDate: 'Issue date', sellerName: 'Seller name', sellerTaxId: 'Seller tax ID',
  buyerName: 'Buyer name', buyerTaxId: 'Buyer tax ID', currency: 'Currency', netAmount: 'Net amount', taxAmount: 'Tax amount',
  totalAmount: 'Total amount', description: 'Description', quantity: 'Quantity', unit: 'Unit', unitPrice: 'Unit price', taxRate: 'Tax rate',
};

export function InvoiceFieldDetails({ value, path, issues }: { value: StoredInvoiceField; path: string; issues: readonly InvoiceIssue[] }) {
  const fieldIssues = issues.filter(issue => issue.fieldPaths.includes(`/${path.replaceAll('.', '/')}`));
  return <div className="invoice-field-details" data-field-path={path}>
    <p>Raw: {value.raw ?? '—'}</p><p>Normalized: {value.normalized ?? '—'}</p>
    <p>State: {value.state.replaceAll('_', ' ')}</p>
    <p>Alternatives: {value.alternatives.length ? value.alternatives.join(' · ') : 'None'}</p>
    <p>Origin: {value.valueOrigin ?? 'Document value (no explicit origin marker)'}</p>
    {value.valueOrigin === 'user-provided' && <p>No document source: provided by the user.</p>}
    {value.sources.map((source, index) => <p key={index}>Source {index + 1}: document {source.documentId} · {source.version} · artifact {source.artifactId}
      {' · '}page {source.page} · {source.blockId ?? 'whole page'} · Quote: {source.quote ?? 'None'}</p>)}
    {fieldIssues.map((issue, index) => <p key={index}>{issue.severity} · {issue.code} · {issue.message}</p>)}
  </div>;
}

export function WorkspacePage(props: {
  state: WorkspaceState; workspace: WorkspaceSnapshot | null; document: DocumentSnapshot | null;
  job: JobSnapshot | null; chatName: string | null; candidate: CandidateJobDetail | null;
  candidateLoading: boolean; candidateError: string | null;
  parsedPage: InvoiceToolOutput<'read_invoice_document'> | null; original: DocumentOriginalImage | null;
  pages: readonly number[];
  materialLoading: boolean; materialError: string | null; originalPageSelectable: boolean;
  view: WorkspaceView; dependentReady: boolean; formControls: ReactNode;
  onRefresh(): void; onView(view: WorkspaceView): void; onPage(page: number): void; onMoreBlocks(): void;
  onSelection(selection: WorkspaceSelection | null): void; onSource(source: SourceRef): void;
  onSelectCandidate(jobId: number, candidateId: number): void;
}) {
  const { workspace, document, job, candidate, dependentReady } = props;
  const currentDocument = !!document && document.documentRef.id === workspace?.documentRef?.id && document.documentRef.version === workspace.documentRef.version;
  const parsedPage = currentDocument && props.parsedPage?.documentRef.id === document.documentRef.id
    && props.parsedPage.documentRef.version === document.documentRef.version && props.parsedPage.parsedArtifactId === document.parsedArtifactId ? props.parsedPage : null;
  const original = currentDocument && props.original?.documentRef.id === document.documentRef.id
    && props.original.documentRef.version === document.documentRef.version ? props.original : null;
  const currentParsed = parsedPage !== null;
  const candidateMatches = !!candidate && candidate.candidate.jobId === workspace?.jobId && candidate.candidate.candidateId === workspace?.candidateRef?.id
    && candidate.candidate.sequence === workspace.candidateRef.sequence && candidate.documentRef.id === workspace.documentRef?.id
    && candidate.documentRef.version === workspace.documentRef?.version;
  const selectedCandidate = candidateMatches && !props.candidateError && !props.candidateLoading;
  const sourceSelection = (page: number, block?: string): WorkspaceSelection | null => !document || !currentDocument ? null : {
    formatVersion: 1, kind: 'source', target: 'document', targetId: document.documentRef.id,
    targetVersion: document.documentRef.version, artifactId: document.parsedArtifactId, page, ...(block ? { block } : {}),
  };
  const selected = (selection: WorkspaceSelection | null) => selection !== null && sameWorkspaceSelection(workspace?.selection ?? null, selection);
  const fieldSelection = (path: string): WorkspaceSelection | null => !candidate ? null : { formatVersion: 1, kind: 'field', target: 'candidate',
    targetId: candidate.candidate.candidateId, targetVersion: candidate.candidate.sequence, fieldPath: path };
  const fromSource = (source: SourceRef): WorkspaceSelection => ({ formatVersion: 1, kind: 'source', target: 'document',
    targetId: source.documentId, targetVersion: source.version, artifactId: source.artifactId, page: source.page,
    ...(source.blockId ? { block: source.blockId } : {}) });
  const field = (value: StoredInvoiceField, path: string, label: string) => <article className={`workspace-field ${selected(fieldSelection(path)) ? 'selected' : ''}`} key={path}>
    <div><strong>{label}</strong><InvoiceFieldDetails value={value} path={path} issues={candidate!.candidate.issues} /></div>
    <button className="text-button" disabled={!dependentReady || !selectedCandidate} aria-label={`Select ${label}`} aria-pressed={selected(fieldSelection(path))}
      onClick={() => props.onSelection(fieldSelection(path))}>Select field</button>
    {value.sources.length > 0 && <div className="workspace-sources">{value.sources.map((source, index) => <button key={index} className="text-button"
      disabled={!dependentReady || !selectedCandidate} aria-label={`${label} source ${index + 1}`}
      aria-pressed={selected(fromSource(source))}
      onClick={() => props.onSource(source)}>Page {source.page}{source.blockId ? ` · ${source.blockId}` : ''}{source.quote ? ` · ${source.quote}` : ''}</button>)}</div>}
  </article>;
  return <section className="page-content workspace-page" data-testid="workspace-page">
    <div className="page-heading"><div><h1>Workspace</h1><p>The confirmed invoice, processing task, saved result and selection for your next message.</p></div>
      <button className="secondary-button" disabled={props.state.status === 'saving'} onClick={props.onRefresh}>Refresh workspace</button></div>
    <section className="panel workspace-summary" data-testid="workspace-summary" aria-label="Current workspace">
      <dl><div><dt>Invoice</dt><dd>{document?.displayName ?? (workspace?.documentRef ? 'Loading invoice…' : 'No invoice selected')}</dd></div>
        <div><dt>Processing task</dt><dd>{job?.goal ?? (workspace?.jobId ? 'Loading processing task…' : 'No processing task selected')}</dd></div>
        <div><dt>Saved result</dt><dd>{workspace?.candidateRef ? `Result ${workspace.candidateRef.sequence}` : 'No saved result selected'}</dd></div>
        <div><dt>Chat</dt><dd>{props.chatName ?? (workspace?.sessionId ? 'Loading chat…' : 'No chat selected')}</dd></div>
        <div><dt>Selection</dt><dd>{selectionLabel(workspace?.selection ?? null)}</dd></div></dl>
      <button className="text-button" disabled={!workspace?.selection || props.state.status === 'saving' || props.state.status === 'loading'}
        onClick={() => props.onSelection(null)}>Clear selection</button>
    </section>
    {props.state.status !== 'ready' && <p className={`notice ${props.state.status === 'loading' || props.state.status === 'saving' ? 'info' : 'bad'}`} role="status">
      {props.state.status === 'saving' ? 'Saving workspace selection…' : props.state.status === 'loading' ? 'Restoring workspace…' : props.state.message ?? 'Workspace could not be confirmed. Refresh to try again.'}</p>}
    {!workspace?.documentRef ? <div className="empty-route"><strong>No invoice selected</strong><span>Choose an invoice in Invoices to begin.</span></div> :
      <section className="panel config-panel workspace-material" aria-label="Workspace material">
        <div className="button-row invoice-tabs" role="tablist" aria-label="Workspace view">{(['original', 'parsed', 'candidate'] as const).map(view =>
          <button key={view} role="tab" aria-selected={props.view === view} className={props.view === view ? 'secondary-button' : 'text-button'}
            disabled={!dependentReady} onClick={() => props.onView(view)}>{view === 'candidate' ? 'Results' : view === 'original' ? 'Original' : 'Parsed'}</button>)}</div>
        {props.materialLoading && <p role="status">Loading invoice material…</p>}
        {props.materialError && <p role="alert">{props.materialError}<button className="text-button" onClick={props.onRefresh}>Retry material</button></p>}
        {props.view === 'original' && <>{original ? <figure className="workspace-original"><img src={`data:${original.mimeType};base64,${original.base64}`} alt="Original invoice page 1" />
          <figcaption>Original page 1</figcaption></figure> : !props.materialLoading && <p>Original page 1 is unavailable.</p>}
          <button className="secondary-button" disabled={!dependentReady || !currentDocument || !!props.materialError || props.materialLoading || !props.originalPageSelectable} aria-pressed={selected(sourceSelection(1))} onClick={() => { const selection = sourceSelection(1); if (selection) props.onSelection(selection); }}>Select page 1</button>
          {!props.materialLoading && !props.originalPageSelectable && <p className="config-note">A matching parsed page 1 is required to select this page.</p>}</>}
        {props.view === 'parsed' && <><div className="button-row"><label className="field"><span>Parsed page</span><select aria-label="Parsed page" value={parsedPage?.page ?? 1}
          disabled={!dependentReady || props.materialLoading || !document} onChange={event => props.onPage(Number(event.target.value))}>
          {props.pages.map(page => <option key={page} value={page}>Page {page}</option>)}</select></label>
          <button className="secondary-button" disabled={!dependentReady || !currentParsed || !!props.materialError || props.materialLoading} aria-pressed={!!parsedPage && selected(sourceSelection(parsedPage.page))} onClick={() => { if (currentParsed && parsedPage) { const selection = sourceSelection(parsedPage.page); if (selection) props.onSelection(selection); } }}>Select parsed page</button></div>
          {parsedPage ? <div className="workspace-blocks">{parsedPage.blocks.map(block => <article key={block.id} className={`workspace-block ${selected(sourceSelection(parsedPage.page, block.id)) ? 'selected' : ''}`}>
            <div><strong>{block.kind === 'table' ? 'Table' : block.kind === 'image' ? 'Image note' : 'Text'} · Page {parsedPage.page} · {block.id}</strong><p>{block.text || '(no extracted text)'}</p></div>
            <button className="text-button" disabled={!dependentReady || !currentParsed || !!props.materialError || props.materialLoading} aria-label={`Select block ${block.id}`} aria-pressed={selected(sourceSelection(parsedPage.page, block.id))} onClick={() => { if (currentParsed) { const selection = sourceSelection(parsedPage.page, block.id); if (selection) props.onSelection(selection); } }}>Select block</button>
          </article>)}</div> : !props.materialLoading && <p>No parsed page loaded.</p>}
          {parsedPage?.nextAfterBlockId && <button className="secondary-button" disabled={props.materialLoading} onClick={props.onMoreBlocks}>More blocks</button>}</>}
        {props.view === 'candidate' && <>{props.candidateLoading && <p role="status">Loading saved result…</p>}
          {props.candidateError && <p role="alert">{props.candidateError}<button className="text-button" onClick={props.onRefresh}>Retry result</button></p>}
          {!candidate && !props.candidateLoading && <p>No saved result selected. Prepare or select a result in Invoices or Processing History.</p>}
          {candidate && <div className="workspace-candidate"><h2>Result {candidate.candidate.sequence}</h2>
            {!candidateMatches && <div className="notice info">This is a preview. Select this result before choosing its fields, lines or sources.
              {workspace?.jobId && <button className="secondary-button" disabled={!dependentReady} onClick={() => props.onSelectCandidate(workspace.jobId!, candidate.candidate.candidateId)}>Select result</button>}</div>}
            <div className="workspace-fields">{invoiceHeaderFields.map(name => field(candidate.candidate.fields[name], `fields.${name}`, labels[name]))}</div>
            <h3>Line items</h3>{candidate.candidate.lines.length ? candidate.candidate.lines.map((line, index) => <section className="workspace-line" key={index}>
              <div className="panel-head"><h4>Line {index + 1}</h4><button className="secondary-button" disabled={!dependentReady || !selectedCandidate}
                aria-pressed={selected({ formatVersion: 1, kind: 'line', target: 'candidate', targetId: candidate.candidate.candidateId, targetVersion: candidate.candidate.sequence, lineIndex: index })}
                onClick={() => props.onSelection({ formatVersion: 1, kind: 'line', target: 'candidate', targetId: candidate.candidate.candidateId,
                  targetVersion: candidate.candidate.sequence, lineIndex: index })}>Select line {index + 1}</button></div>
              <div className="workspace-fields">{invoiceLineFields.map(name => field(line[name], `lines.${index}.${name}`, `Line ${index + 1} ${labels[name]}`))}</div>
            </section>) : <p>No line items were saved.</p>}
            <h3>Issues</h3>{candidate.candidate.issues.length ? <ul>{candidate.candidate.issues.map((issue, index) => <li key={index}>{issue.message}</li>)}</ul> : <p>No validation issues.</p>}
            <h3>Sources</h3>{candidate.candidate.sources.length ? <div className="workspace-sources">{candidate.candidate.sources.map((source, index) => <button className="text-button" key={index}
              disabled={!dependentReady || !selectedCandidate} aria-label={`Result source ${index + 1}`} aria-pressed={selected(fromSource(source))} onClick={() => props.onSource(source)}>Page {source.page}{source.blockId ? ` · ${source.blockId}` : ''}{source.quote ? ` · ${source.quote}` : ''}</button>)}</div> : <p>No source links were saved.</p>}
          </div>}{props.formControls}</>}
      </section>}
  </section>;
}
