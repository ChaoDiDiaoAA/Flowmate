import { useEffect, useRef, useState } from 'react';
import type { DocumentSnapshot, ResearchTask, ResearchPlan, ResearchReport, ResearchMaterial, SourceSnapshot,
  Claim, ResearchIntent, ResearchPlanBody, Result } from '@flowmate/contracts';

type Props = { ready: boolean; canRun: boolean; selectedId: number | null; refreshToken: string;
  documents: DocumentSnapshot[]; onSelect(task: ResearchTask, draft?: string): void; onUpdated(task: ResearchTask): void;
  onAssistant(collapsed: boolean): void; running: boolean; stopping: boolean; onStop(): void;
  onRun(text: string, intent: ResearchIntent, execution?: ResearchPlanBody['execution']): void };
function need<T>(result: Result<T>): T { if (!result.ok) throw new Error(result.error.message); return result.data; }

export function ResearchPage(props: Props) {
  const [tasks, setTasks] = useState<ResearchTask[]>([]), [taskCursor, setTaskCursor] = useState<number | null>(null);
  const [task, setTask] = useState<ResearchTask | null>(null), [plan, setPlan] = useState<ResearchPlan | null>(null);
  const [report, setReport] = useState<ResearchReport | null>(null), [reports, setReports] = useState<ResearchReport[]>([]), [reportCursor, setReportCursor] = useState<number | null>(null);
  const [planChanges, setPlanChanges] = useState('');
  const [sources, setSources] = useState<SourceSnapshot[]>([]), [sourceCursor, setSourceCursor] = useState<number | null>(null);
  const [claims, setClaims] = useState<Claim[]>([]), [claimCursor, setClaimCursor] = useState<number | null>(null);
  const [materials, setMaterials] = useState<ResearchMaterial[]>([]), [materialCursor, setMaterialCursor] = useState<number | null>(null);
  const [view, setView] = useState<'Plan' | 'Evidence' | 'Report'>('Plan'), [creating, setCreating] = useState(false);
  const [question, setQuestion] = useState(''), [scope, setScope] = useState('');
  const [artifactIds, setArtifactIds] = useState<number[]>([]), [documentIds, setDocumentIds] = useState<number[]>([]);
  const [loading, setLoading] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<{ source: SourceSnapshot; excerpt: { start: number; end: number; quote: string }; nextOffset: number | null } | null>(null);
  const generation = useRef(0), evidenceGeneration = useRef(0);
  const initializedTask = useRef<number | null>(null), operation = useRef(false);
  const questionInput = useRef<HTMLTextAreaElement>(null), newResearchButton = useRef<HTMLButtonElement>(null);
  async function refresh() {
    const token = ++generation.current; setLoading(true); setError(null);
    try {
      const [listed, local] = await Promise.all([window.flowmate.listResearchTasks({ limit: 30 }), window.flowmate.listResearchMaterials({ limit: 30 })]);
      const next = need(listed), imported = need(local);
      if (token !== generation.current) return;
      setTasks(next.items); setTaskCursor(next.nextBeforeId); setMaterials(imported.items); setMaterialCursor(imported.nextBeforeId);
      if (props.selectedId === null) { setTask(null); setPlan(null); setReport(null); return; }
      const selected = need(await window.flowmate.queryResearchTask(props.selectedId));
      const [savedPlan, savedSources, savedReports] = await Promise.all([
        selected.currentPlanId ? window.flowmate.queryResearchPlan({ researchId: selected.researchId, planId: selected.currentPlanId }) : null,
        window.flowmate.listResearchSources({ researchId: selected.researchId, limit: 30 }),
        window.flowmate.listResearchReports({ researchId: selected.researchId, limit: 100 })]);
      const currentPlan = savedPlan ? need(savedPlan) : null, sourcePage = need(savedSources), reportPage = need(savedReports);
      const currentReport = reportPage.items.find(item => item.reportId === selected.currentReportId) ?? null;
      const claimPage = currentPlan ? need(await window.flowmate.listResearchClaims({ researchId: selected.researchId, planId: currentPlan.planId, limit: 30 })) : null;
      if (token !== generation.current) return;
      setTask(selected); props.onUpdated(selected); setPlan(currentPlan); setSources(sourcePage.items); setSourceCursor(sourcePage.nextBeforeId);
      setReports(previous => [...reportPage.items, ...previous.filter(item => item.researchId === selected.researchId && !reportPage.items.some(next => next.reportId === item.reportId))]);
      setReportCursor(reportPage.nextBeforeId);
      setReport(previous => previous?.researchId === selected.researchId ? previous : currentReport ?? reportPage.items[0] ?? null);
      setClaims(claimPage?.items ?? []); setClaimCursor(claimPage?.nextBeforeId ?? null);
      if (initializedTask.current !== selected.researchId) {
        initializedTask.current = selected.researchId;
        setView(reportPage.items.length ? 'Report' : 'Plan');
      }
    } catch (cause) { if (token === generation.current) setError(cause instanceof Error ? cause.message : 'Research could not be read.'); }
    finally { if (token === generation.current) setLoading(false); }
  }
  useEffect(() => { if (props.ready) void refresh(); return () => { generation.current++; evidenceGeneration.current++; }; }, [props.ready, props.selectedId, props.refreshToken]);
  useEffect(() => { setEvidence(null); setView('Plan'); setCreating(false); setPlanChanges(''); setMessage(null); }, [props.selectedId]);
  useEffect(() => { if (creating) questionInput.current?.focus(); }, [creating]);
  async function operate(action: () => Promise<void>) {
    if (operation.current) return; operation.current = true; setSaving(true); setError(null); setMessage(null);
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'The research operation failed. Refresh before retrying.'); }
    finally { operation.current = false; setSaving(false); }
  }
  async function create() {
    await operate(async () => {
      const session = need(await window.flowmate.createSession({ title: [...question.trim()].slice(0, 80).join('') }));
      const created = need(await window.flowmate.createResearchTask({ sessionId: session.sessionId, title: [...question.trim()].slice(0, 120).join(''),
        sourcePolicy: { web: false, domains: [], artifactIds, documentIds } }));
      setCreating(false); props.onSelect(created, `${question.trim()}${scope.trim() ? `\n\nResearch scope: ${scope.trim()}` : ''}`);
      setMessage('Research created. Press Send in Assistant to generate a plan. Investigation starts only after you confirm it.');
    });
  }
  async function readEvidence(sourceSnapshotId: number, offset = 0) {
    if (!task) return; const token = ++evidenceGeneration.current;
    try { const result = need(await window.flowmate.queryResearchEvidence({ researchId: task.researchId, sourceSnapshotId, offset, limit: 4000 }));
      if (token === evidenceGeneration.current) { setEvidence(result); setView('Evidence'); } }
    catch (cause) { if (token === evidenceGeneration.current) setError(cause instanceof Error ? cause.message : 'Evidence could not be read.'); }
  }
  async function readClaim(claimId: number) {
    if (!task) return; const token = ++evidenceGeneration.current;
    try { const claim = need(await window.flowmate.queryResearchClaim({ researchId: task.researchId, claimId }));
      if (token === evidenceGeneration.current) { setClaims([claim]); setClaimCursor(null); setEvidence(null); setView('Evidence'); } }
    catch (cause) { if (token === evidenceGeneration.current) setError(cause instanceof Error ? cause.message : 'Claim could not be read.'); }
  }
  const toggle = (ids: number[], id: number) => ids.includes(id) ? ids.filter(item => item !== id) : [...ids, id];
  const statusLabel = (value: string) => value.replaceAll('_', ' ');
  const reportFeedback = !creating && view === 'Report' && report !== null && task?.researchId === props.selectedId;
  return <section className="page-content research-page" aria-label="Deep Research workspace">
    <header className="page-heading research-heading">
      <div><h1>Deep Research</h1><p>Turn your local materials into a report you can trace and review.</p></div>
      <div className="button-row">
        <button type="button" className="text-button" disabled={!props.ready || loading || saving} onClick={() => void refresh()}>Refresh research</button>
        <button ref={newResearchButton} type="button" className="primary-button" disabled={!props.ready || saving || creating} onClick={() => { setCreating(true); setError(null); setMessage(null); props.onAssistant(true); }}>New research</button>
      </div>
    </header>
    <ol className="research-steps" aria-label="Research workflow"><li>Question &amp; materials</li><li>Confirm plan</li><li>Research report</li></ol>
    {error && !reportFeedback && <p role="alert" className="notice bad research-error">{error}</p>}
    {message && !reportFeedback && <p role="status" className="notice research-feedback">{message}</p>}
    {loading && <p role="status" className="research-loading">Loading saved research…</p>}
    {creating ? <form className="research-create panel" onSubmit={event => { event.preventDefault(); void create(); }}>
      <div className="research-form-head"><div><h2>New research</h2><p>Start with a question and choose the materials to investigate.</p></div><span className="research-badge">Local materials</span></div>
      <div className="research-form-body">
        <label className="field"><span>Research question</span><textarea ref={questionInput} required maxLength={16000} placeholder="Compare three Agent deployment options using our team policy. What are the trade-offs?" value={question} onChange={event => setQuestion(event.target.value)} /></label>
        <details className="research-scope"><summary>Scope and constraints <span>Optional</span></summary><label className="field"><span>Research scope and constraints</span><textarea maxLength={16000} placeholder="For example: deployment environment, cost limits, required capabilities…" value={scope} onChange={event => setScope(event.target.value)} /></label></details>
        <section className="research-materials" aria-label="Research materials">
          <div className="research-materials-head"><div><h3>Research materials</h3><p>Text, Markdown and parsed documents</p></div><span className="research-badge">{artifactIds.length + documentIds.length} selected</span></div>
          <label className="secondary-button research-import"><span aria-hidden="true">＋</span> Import text or Markdown
            <input type="file" aria-label="Import text or Markdown" accept=".txt,.md,.markdown,text/plain,text/markdown" disabled={saving} onChange={event => {
              const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
              void operate(async () => { if (file.size > 2_000_000) throw new Error('Choose a UTF-8 text file no larger than 2 MB.');
                const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer());
                const material = need(await window.flowmate.importResearchMaterial({ title: file.name, format: /\.(md|markdown)$/i.test(file.name) ? 'markdown' : 'text', text }));
                setMaterials(items => [material, ...items.filter(item => item.artifactId !== material.artifactId)]); setArtifactIds(ids => [...new Set([...ids, material.artifactId])]);
              });
            }} />
          </label>
          <div className="research-material-list">
            {!materials.length && !props.documents.length && <p className="research-material-empty">Import a file to add the first source for this research.</p>}
            {materials.map(item => <label className="research-material" key={item.artifactId}><input type="checkbox" checked={artifactIds.includes(item.artifactId)} onChange={() => setArtifactIds(toggle(artifactIds, item.artifactId))} /><span><strong>{item.title}</strong><small>{item.format === 'markdown' ? 'Markdown' : 'Text'} · {item.bytes.toLocaleString()} bytes</small></span></label>)}
            {materialCursor && <button type="button" className="text-button" onClick={() => void operate(async () => { const page = need(await window.flowmate.listResearchMaterials({ beforeId: materialCursor, limit: 30 })); setMaterials(items => [...items, ...page.items]); setMaterialCursor(page.nextBeforeId); })}>More materials</button>}
            {props.documents.map(item => <label className="research-material" key={item.documentRef.id}><input type="checkbox" checked={documentIds.includes(item.documentRef.id)} onChange={() => setDocumentIds(toggle(documentIds, item.documentRef.id))} /><span><strong>{item.displayName}</strong><small>Parsed document</small></span></label>)}
          </div>
          <p className="research-help">Only selected materials are included. Your current invoice is not added automatically.</p>
        </section>
      </div>
      <footer className="research-form-actions"><span>Create the task, then send your question in Assistant to generate a plan.</span><div className="button-row"><button type="button" className="text-button" disabled={saving} onClick={() => { setCreating(false); requestAnimationFrame(() => newResearchButton.current?.focus()); }}>Cancel</button><button className="primary-button" type="submit" disabled={!question.trim() || saving}>Create research</button></div></footer>
    </form> : <div className="research-columns">
      <aside className="research-list" aria-label="Research list">
        <details className="research-task-picker"><summary>{task?.title ?? 'Choose research'}<span>{tasks.length} tasks</span></summary><div>
          {tasks.map(item => <button key={item.researchId} type="button" className="research-task" aria-pressed={props.selectedId === item.researchId} disabled={saving} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); props.onSelect(item); }}><strong>{item.title}</strong><span>{statusLabel(item.status)}</span></button>)}
        </div></details>
        <div className="research-task-index"><h2>Research tasks</h2>
          {!tasks.length && !loading && <p>No research yet. Create a question to begin.</p>}
          {tasks.map(item => <button key={item.researchId} type="button" className="research-task" aria-pressed={props.selectedId === item.researchId} disabled={saving} onClick={() => props.onSelect(item)}><strong>{item.title}</strong><span className="research-task-state">{statusLabel(item.status)}</span><time dateTime={item.updatedAt}>{new Date(item.updatedAt).toLocaleDateString()}</time></button>)}
        </div>
        {taskCursor && <button type="button" className="text-button" disabled={saving} onClick={() => void operate(async () => { const page = need(await window.flowmate.listResearchTasks({ beforeId: taskCursor, limit: 30 })); setTasks(items => [...items, ...page.items]); setTaskCursor(page.nextBeforeId); })}>More research</button>}
      </aside>
      <div className="research-detail" aria-busy={loading} inert={loading || task?.researchId !== props.selectedId}>
        {task ? <>
          <header className="research-detail-heading"><div><span className="research-badge">{statusLabel(task.status)}</span><h2>{task.title}</h2><details className="research-execution"><summary>Task details</summary><p>Research {task.researchId} · Assistant session {task.sessionId}</p></details></div>
            <div className="button-row"><button type="button" className="secondary-button" onClick={() => props.onAssistant(false)}>Open research Assistant</button>{props.running && <button type="button" className="secondary-button" disabled={props.stopping} onClick={props.onStop}>{props.stopping ? 'Stopping…' : 'Stop research'}</button>}</div>
          </header>
          <div className="research-tabs" role="group" aria-label="Research views">{(['Plan', 'Evidence', 'Report'] as const).map(name => <button type="button" key={name} aria-pressed={view === name} onClick={() => { setView(name); if (name === 'Report') props.onAssistant(true); }}>{name}</button>)}</div>
          {view === 'Plan' && (plan ? <div className="research-plan">
            <div className="research-section-heading"><h3>Plan version {plan.revision}</h3><span className="research-badge">{plan.body.dimensions.length} dimensions</span></div>
            <p className="research-prose">{plan.body.question}</p><p className="research-prose research-help">{plan.body.scope}</p>
            {plan.body.dimensions.map(dimension => <section className="research-dimension" key={dimension.id}><h4>{dimension.title}</h4>{dimension.questions.map(item => <div key={item.id}><p>{item.question}</p><ul>{item.evidenceNeeded.map((text, index) => <li key={index}>{text}</li>)}</ul></div>)}</section>)}
            <details className="research-execution"><summary>Source scope, budget and stop conditions</summary>
              <h4>Source scope</h4><p>Local materials: {plan.body.sourcePolicy.artifactIds.length}; parsed documents: {plan.body.sourcePolicy.documentIds.length}. Online search is unavailable in this version.</p>
              <h4>Execution budget</h4><p>{plan.body.execution.budget.maxModelCalls} model calls; {plan.body.execution.budget.maxToolCalls} tool calls; {plan.body.execution.timeoutMs / 1000} seconds.</p>
              <h4>Stop conditions</h4><ul>{plan.body.stopConditions.map((text, index) => <li key={index}>{text}</li>)}</ul>
            </details>
            <div className="research-plan-confirm"><p className="research-help">{plan.body.sourcePolicy.artifactIds.length + plan.body.sourcePolicy.documentIds.length} authorized materials · {plan.body.execution.budget.maxModelCalls} model calls · {plan.body.execution.budget.maxToolCalls} tool calls · {plan.body.execution.timeoutMs / 1000} seconds</p><button type="button" className="primary-button" disabled={!props.canRun || task.status !== 'awaiting_confirmation' || loading || saving} onClick={() => props.onRun('I confirm research plan version ' + plan.revision + '. Investigate within its source scope and budget.',
              { researchId: task.researchId, phase: 'researching', plan: { planId: plan.planId, revision: plan.revision } }, plan.body.execution)}>Confirm plan version {plan.revision}</button><p className="research-help">Investigation starts after you confirm this version.</p></div>
            <label className="field"><span>Plan changes</span><textarea maxLength={16000} placeholder="Describe the changes you want before confirming…" value={planChanges} onChange={event => setPlanChanges(event.target.value)} /></label>
            <button type="button" className="secondary-button" disabled={!props.canRun || !planChanges.trim() || loading || saving} onClick={() => props.onRun(planChanges, { researchId: task.researchId, phase: 'planning', plan: null })}>Revise plan</button>
            <p className="research-help">Changing authorized materials requires a new research task.</p>
          </div> : <div className="research-empty"><h3>Start with a research plan</h3><p>Send your question in Assistant. Review the saved plan here before confirming the investigation.</p><button type="button" className="secondary-button" onClick={() => props.onAssistant(false)}>Open research Assistant</button></div>)}
          {view === 'Evidence' && <div className="research-evidence"><div className="research-section-heading"><h3>Saved sources</h3><span className="research-badge">{sources.length} loaded</span></div>
            {!sources.length && <p className="research-help">No source snapshots saved yet.</p>}
            {sources.map(source => <section key={source.sourceSnapshotId} className="research-source"><div className="research-section-heading"><strong>{source.title}</strong><button type="button" className="text-button" onClick={() => void readEvidence(source.sourceSnapshotId)}>View source {source.sourceSnapshotId}</button></div><p className="research-help">{source.address}</p><details className="research-execution"><summary>Execution details</summary><p>Run {source.runId} / ToolCall {source.toolCallId} · {source.fetchedAt}{source.truncated ? ' · truncated' : ''}</p><p>SHA-256: {source.contentHash}</p></details></section>)}
            {sourceCursor && <button type="button" className="text-button" disabled={saving} onClick={() => void operate(async () => { const page = need(await window.flowmate.listResearchSources({ researchId: task.researchId, beforeId: sourceCursor, limit: 30 })); setSources(items => [...items, ...page.items]); setSourceCursor(page.nextBeforeId); })}>More sources</button>}
            {evidence && <section className="research-source-passage" aria-label="Saved source text"><h4>{evidence.source.title}</h4><details className="research-execution"><summary>Passage details</summary><p>SHA-256: {evidence.source.contentHash} · offsets {evidence.excerpt.start}–{evidence.excerpt.end}</p></details><pre className="research-prose">{evidence.excerpt.quote}</pre>{evidence.nextOffset !== null && <button type="button" className="text-button" onClick={() => void readEvidence(evidence.source.sourceSnapshotId, evidence.nextOffset!)}>Next source passage</button>}</section>}
            <h3>Claim verification</h3>{claims.map(claim => <section className="research-source" key={claim.claimId}><h4>Claim {claim.claimId} · {claim.verification.status}</h4><p className="research-prose">{claim.text}</p><ul>{claim.verification.reasons.map((text, index) => <li key={index}>{text}</li>)}</ul><details className="research-execution"><summary>Dependencies</summary>{claim.dependencies.length ? claim.dependencies.map(id => <button type="button" className="text-button" key={id} onClick={() => void readClaim(id)}>Inspect dependency {id}</button>) : <p>None</p>}</details>{claim.evidence.map((item, index) => <div className="research-claim-evidence" key={index}><p>{item.relation}: {item.ref.locator.quote}</p><button type="button" className="text-button" onClick={() => void readEvidence(item.ref.sourceSnapshotId, item.ref.locator.start)}>Inspect evidence for claim {claim.claimId} / source {item.ref.sourceSnapshotId}</button></div>)}</section>)}
            {claimCursor && plan && <button type="button" className="text-button" disabled={saving} onClick={() => void operate(async () => { const page = need(await window.flowmate.listResearchClaims({ researchId: task.researchId, planId: plan.planId, beforeId: claimCursor, limit: 30 })); setClaims(items => [...items, ...page.items]); setClaimCursor(page.nextBeforeId); })}>More claims</button>}
          </div>}
          {view === 'Report' && (report ? <div className="research-report">
            <div className="research-report-toolbar" aria-label="Report actions">
              <label className="field"><span>Saved report</span><select aria-label="Saved report" disabled={saving} value={report.reportId} onChange={event => { const next = reports.find(item => item.reportId === Number(event.target.value)); if (next) { setReport(next); setMessage(null); setError(null); } }}>{reports.map(item => <option key={item.reportId} value={item.reportId}>Report {item.reportId} · plan {item.revision} · {item.completeness}</option>)}</select></label>
              <div className="research-export-action"><span className="research-badge">{report.completeness === 'full' ? 'Complete report' : 'Partial report'}</span><button type="button" className="primary-button" disabled={saving || !props.ready} onClick={() => void operate(async () => {
                const result = need(await window.flowmate.saveResearchExport({ researchId: task.researchId, reportId: report.reportId }));
                setMessage(result.cancelled ? 'Save cancelled. Your report is still available here.' : 'Report saved' + (result.destinationPath ? ' to ' + result.destinationPath : '.'));
              })}>Save report</button><small>Markdown .md · choose a location</small></div>
              {error && <p role="alert" className="notice bad research-error">{error}</p>}
              {message && <p role="status" className="notice research-feedback">{message}</p>}
            </div>
            {reportCursor && <button type="button" className="text-button" disabled={saving} onClick={() => void operate(async () => { const page = need(await window.flowmate.listResearchReports({ researchId: task.researchId, beforeId: reportCursor, limit: 100 })); setReports(items => [...items, ...page.items.filter(next => !items.some(item => item.reportId === next.reportId))]); setReportCursor(page.nextBeforeId); })}>More reports</button>}
            <article className="research-report-body">
              <p className="research-help">Report {report.reportId} · Plan version {report.revision} · Saved {new Date(report.createdAt).toLocaleString()}</p>
              <h3>Research answer</h3><p className="research-prose research-answer">{report.answer}</p>
              {report.sections.map((section, index) => <section key={index}><h3>{section.title}</h3><p className="research-prose">{section.text}</p><div className="research-citations">{section.claimIds.map(id => <button type="button" className="secondary-button" key={id} onClick={() => void readClaim(id)}>Inspect claim {id}</button>)}</div></section>)}
              <section><h3>Coverage</h3><ul className="research-coverage">{report.coverage.map(row => <li key={row.questionId}><strong>{row.questionId}</strong><span className="research-badge">{row.status}</span><p>{row.reason}</p><small>Claims: {row.claimIds.join(', ') || 'none'}</small></li>)}</ul></section>
              {([['Conflicts', report.conflicts], ['Limitations', report.limitations], ['Unresolved questions', report.unresolvedQuestions]] as const).map(([title, items]) => <section key={title}><h3>{title}</h3>{items.length ? <ul>{items.map((text, index) => <li key={index}>{text}</li>)}</ul> : <p className="research-help">None recorded.</p>}</section>)}
              <p className="research-help">Verification is recorded per claim and does not guarantee every conclusion is true.</p>
              <footer className="research-report-footer"><p>Continue with this research in Assistant.</p><button type="button" className="secondary-button" onClick={() => props.onAssistant(false)}>Ask follow-up</button></footer>
            </article>
          </div> : <div className="research-empty"><h3>No saved report yet</h3><p>Reports appear here after the investigation saves its findings. Partial evidence and failed source calls remain available in Evidence and Assistant.</p><button type="button" className="primary-button" disabled>Save report</button></div>)}
        </> : <div className="research-empty"><h2>A report starts with a question</h2><p>Select a saved research task or create a new one.</p></div>}
      </div>
    </div>}
  </section>;
}
