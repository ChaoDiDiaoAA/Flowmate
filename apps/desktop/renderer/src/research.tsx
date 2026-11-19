import { useEffect, useRef, useState } from 'react';
import { researchCitationKey } from '@flowmate/contracts';
import type { ResearchReference, ResearchReportDocument, ResearchSentence } from '@flowmate/contracts';
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
  const [currentRunStopped, setCurrentRunStopped] = useState(false);
  const [report, setReport] = useState<ResearchReport | null>(null), [reports, setReports] = useState<ResearchReport[]>([]), [reportCursor, setReportCursor] = useState<number | null>(null);
  const [planChanges, setPlanChanges] = useState('');
  const [format, setFormat] = useState<'markdown' | 'pdf'>('markdown');
  const [document, setDocument] = useState<ResearchReportDocument | null>(null);
  const [referenceNumber, setReferenceNumber] = useState<number | null>(null);
  const referencePanel = useRef<HTMLElement>(null);
  const [documentError, setDocumentError] = useState<string | null>(null);
  const [sources, setSources] = useState<SourceSnapshot[]>([]), [sourceCursor, setSourceCursor] = useState<number | null>(null);
  const [claims, setClaims] = useState<Claim[]>([]), [claimCursor, setClaimCursor] = useState<number | null>(null);
  const [materials, setMaterials] = useState<ResearchMaterial[]>([]), [materialCursor, setMaterialCursor] = useState<number | null>(null);
  const [view, setView] = useState<'Plan' | 'Evidence' | 'Report'>('Plan'), [creating, setCreating] = useState(false);
  const [question, setQuestion] = useState(''), [scope, setScope] = useState('');
  const [webEnabled, setWebEnabled] = useState(false), [webConfigured, setWebConfigured] = useState<boolean | null>(null);
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
      const [savedPlan, savedSources, savedReports, savedRun] = await Promise.all([
        selected.currentPlanId ? window.flowmate.queryResearchPlan({ researchId: selected.researchId, planId: selected.currentPlanId }) : null,
        window.flowmate.listResearchSources({ researchId: selected.researchId, limit: 30 }),
        window.flowmate.listResearchReports({ researchId: selected.researchId, limit: 100 }),
        selected.currentRunId === null ? null : window.flowmate.queryRun(selected.currentRunId).catch(() => null)]);
      const currentPlan = savedPlan ? need(savedPlan) : null, sourcePage = need(savedSources), reportPage = need(savedReports);
      const currentReport = reportPage.items.find(item => item.reportId === selected.currentReportId) ?? null;
      const claimPage = currentPlan ? need(await window.flowmate.listResearchClaims({ researchId: selected.researchId, planId: currentPlan.planId, limit: 30 })) : null;
      if (token !== generation.current) return;
      const run = savedRun?.ok ? savedRun.data : null;
      setCurrentRunStopped(run !== null && run.runId === selected.currentRunId && run.sessionId === selected.sessionId
        && ['completed', 'failed', 'cancelled'].includes(run.status)
        && run.stoppedAt !== null && run.cleanup.stopped !== false && run.cleanup.lateObservationRequired !== true);
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
  useEffect(() => {
    if ((!creating && props.selectedId === null) || !props.ready) return;
    let current = true;
    void window.flowmate.queryResearchWebStatus().then(result => {
      if (current) setWebConfigured(result.ok && result.data.configured);
    }).catch(() => { if (current) setWebConfigured(false); });
    return () => { current = false; };
  }, [creating, props.ready, props.selectedId]);

  async function operate(action: () => Promise<void>) {
    if (operation.current) return; operation.current = true; setSaving(true); setError(null); setMessage(null);
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'The research operation failed. Refresh before retrying.'); }
    finally { operation.current = false; setSaving(false); }
  }
  async function create() {
    if (!props.ready || webEnabled && webConfigured !== true) return;
    await operate(async () => {
      const session = need(await window.flowmate.createSession({ title: [...question.trim()].slice(0, 80).join('') }));
      const created = need(await window.flowmate.createResearchTask({ sessionId: session.sessionId, title: [...question.trim()].slice(0, 120).join(''),
        sourcePolicy: { web: webEnabled, domains: [], artifactIds, documentIds } }));
      setCreating(false); props.onSelect(created, `${question.trim()}${scope.trim() ? `\n\nResearch scope: ${scope.trim()}` : ''}`);
      setMessage('Research created. Press Send in Assistant to generate a plan. Investigation starts only after you confirm it.');
    });
  }
  const webRunBusy = props.running || props.stopping || (task !== null && task.currentRunId !== null && !currentRunStopped);
  const webChangeBlocked = !props.ready || loading || saving || webRunBusy;
  const regeneratePlan = props.canRun ? 'Generate a new plan in Assistant and confirm it before continuing.'
    : 'When Assistant is ready, generate a new plan there and confirm it before continuing.';
  let webStatus = '';
  if (webRunBusy) webStatus = 'Wait for the current Run to stop before changing web search.';
  else if (webConfigured === null) webStatus = 'Checking Tavily configuration…';
  else if (!webConfigured) webStatus = 'Set FLOWMATE_TAVILY_API_KEY in the research Host environment to enable web search.';
  async function updateWebAccess(web: boolean) {
    if (!task || task.researchId !== props.selectedId || webChangeBlocked || web && webConfigured !== true) return;
    await operate(async () => {
      const updated = need(await window.flowmate.updateResearchWebAccess({ researchId: task.researchId, web, expectedWeb: task.sourcePolicy.web }));
      setTask(updated); props.onUpdated(updated);
      setPlan(current => current?.planId === updated.currentPlanId ? current : null);
      await refresh();
      setMessage('Web search updated. ' + regeneratePlan);
    });
  }
  const citedReportId = report?.cited ? report.reportId : undefined;
  const citedResearchId = report?.cited ? report.researchId : undefined;
  useEffect(() => {
    setDocument(null); setReferenceNumber(null); setDocumentError(null); setFormat('markdown');
    if (view !== 'Report' || !props.ready || citedReportId === undefined || citedResearchId === undefined) return;
    let current = true;
    void window.flowmate.queryResearchReportDocument({ researchId: citedResearchId, reportId: citedReportId })
      .then(result => {
        if (!current) return;
        if (result.ok) setDocument(result.data);
        else setDocumentError(result.error.message);
      }).catch(() => { if (current) setDocumentError('Saved references could not be loaded.'); });
    return () => { current = false; };
  }, [view, props.ready, props.refreshToken, citedReportId, citedResearchId]);

  const activeDocument = document?.reportId === citedReportId && document?.researchId === citedResearchId ? document : null;
  const reference = activeDocument?.references.find(item => item.number === referenceNumber);
  useEffect(() => { if (reference) referencePanel.current?.focus(); }, [reference]);
  const referenceByCitation = new Map(activeDocument?.references.map(item => [researchCitationKey(item), item]));
  function renderCitation(citation: ResearchSentence['citations'][number], showClaim = false) {
    const key = researchCitationKey(citation);
    const item = referenceByCitation.get(key);
    if (!item) return showClaim ? <span key={key}> · Claim {citation.claimId}, evidence index {citation.evidenceIndex}</span> : null;
    return <button key={key} type="button" className="text-button"
      aria-label={`Reference ${item.number}`} aria-expanded={referenceNumber === item.number}
      onClick={() => setReferenceNumber(item.number)}>[{item.number}]</button>;
  }
  function renderSentences(sentences: ResearchSentence[]) {
    return sentences.map((sentence, index) => <span key={index}>{sentence.text.trim()}{sentence.citations.map(citation => renderCitation(citation))}{' '}</span>);
  }
  function renderSemanticReview(report: ResearchReport) {
    const review = report.semanticReview;
    if (!review) return <p className="research-help">No independent semantic review for this report.</p>;
    return <section aria-label="Semantic review">
      <h3>Semantic review</h3>
      <p className="research-help">{statusLabel(review.status)} · Policy {review.policyVersion} · Run {review.runId} / ToolCall {review.toolCallId}
        {review.status !== 'no_findings' && <> · Model {review.model.provider} / {review.model.model}</>}</p>
      {review.status === 'no_findings' && <p>No findings to review. No review model was called.</p>}
      {review.sentences.map(row => <details className="research-execution" key={row.sentenceIndex}>
        <summary>Sentence {row.sentenceIndex + 1} · {statusLabel(row.verdict)} · {row.complete ? 'complete' : 'incomplete'}</summary>
        <p className="research-prose">{row.text}</p>
        <ul>{row.facts.map((fact, index) => <li key={index}>
          <p className="research-prose"><strong>{fact.text}</strong> · {statusLabel(fact.verdict)} · UTF-16 offsets [{fact.start}, {fact.end})</p>
          <p>{fact.reason}{fact.citations.map(citation => renderCitation(citation, true))}</p>
        </li>)}</ul>
      </details>)}
    </section>;
  }
  function renderReference(item: ResearchReference) {
    const { source, locator } = item;
    return <section ref={referencePanel} tabIndex={-1} className="research-source" aria-label="Selected reference">
      <h3>Reference [{item.number}]</h3>
      <p><strong>{source.title}</strong> · {source.address}</p>
      <p className="research-help">Source snapshot {source.sourceSnapshotId} · Run {source.runId} / ToolCall {source.toolCallId} · UTF-16 offsets [{locator.start}, {locator.end})</p>
      <p className="research-help">Fetched {new Date(source.fetchedAt).toLocaleString()} · {item.relation}</p>
      <pre className="research-prose">{locator.quote}</pre>
      <button type="button" className="text-button" onClick={() => void readEvidence(source.sourceSnapshotId, locator.start, Math.min(4000, locator.end - locator.start))}>View saved passage</button>
      <button type="button" className="text-button" onClick={() => void readClaim(item.claimId)}>Open Claim {item.claimId}</button>
      {source.kind === 'web' && <button type="button" className="text-button" onClick={() => void openWebSource(source)}>Open webpage</button>}
    </section>;
  }

  async function openWebSource(source: SourceSnapshot) {
    await operate(async () => { need(await window.flowmate.openResearchSource({ researchId: source.researchId, sourceSnapshotId: source.sourceSnapshotId })); });
  }
  async function readEvidence(sourceSnapshotId: number, offset = 0, limit = 4000) {
    if (!task) return; const token = ++evidenceGeneration.current;
    try { const result = need(await window.flowmate.queryResearchEvidence({ researchId: task.researchId, sourceSnapshotId, offset, limit }));
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
      <div><h1>Deep Research</h1><p>Build a report you can trace to local materials and optional web sources.</p></div>
      <div className="button-row">
        <button type="button" className="text-button" disabled={!props.ready || loading || saving} onClick={() => void refresh()}>Refresh research</button>
        <button ref={newResearchButton} type="button" className="primary-button" disabled={!props.ready || saving || creating} onClick={() => { setWebEnabled(false); setWebConfigured(null); setCreating(true); setError(null); setMessage(null); props.onAssistant(true); }}>New research</button>
      </div>
    </header>
    <ol className="research-steps" aria-label="Research workflow"><li>Question &amp; materials</li><li>Confirm plan</li><li>Research report</li></ol>
    {error && !reportFeedback && <p role="alert" className="notice bad research-error">{error}</p>}
    {message && !reportFeedback && <p role="status" className="notice research-feedback">{message}</p>}
    {loading && <p role="status" className="research-loading">Loading saved research…</p>}
    {creating ? <form className="research-create panel" onSubmit={event => { event.preventDefault(); void create(); }}>
      <div className="research-form-head"><div><h2>New research</h2><p>Start with a question and choose the materials to investigate.</p></div></div>
      <div className="research-form-body">
        <label className="field"><span>Research question</span><textarea ref={questionInput} required maxLength={16000} placeholder="Compare three Agent deployment options using our team policy. What are the trade-offs?" value={question} onChange={event => setQuestion(event.target.value)} /></label>
        <details className="research-scope"><summary>Scope and constraints <span>Optional</span></summary><label className="field"><span>Research scope and constraints</span><textarea maxLength={16000} placeholder="For example: deployment environment, cost limits, required capabilities…" value={scope} onChange={event => setScope(event.target.value)} /></label></details>
        <label className="research-material"><input type="checkbox" role="switch" aria-label="Web search" aria-describedby="research-web-status"
          checked={webEnabled} disabled={webConfigured !== true || !props.ready || saving} onChange={event => setWebEnabled(event.target.checked)} />
          <span><strong>Web search</strong><small id="research-web-status">{webConfigured === null ? 'Checking Tavily configuration…'
            : webConfigured ? 'Confirmed search queries and public page URLs are sent to Tavily.'
              : 'Set FLOWMATE_TAVILY_API_KEY in the research Host environment to enable web search.'}</small></span>
        </label>
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
            {materials.map(item => <label className="research-material" key={item.artifactId}><input type="checkbox" disabled={!!item.verificationGap} checked={artifactIds.includes(item.artifactId)} onChange={() => setArtifactIds(toggle(artifactIds, item.artifactId))} /><span><strong>{item.title}</strong><small>{item.format === 'markdown' ? 'Markdown' : 'Text'} · {item.bytes.toLocaleString()} bytes{item.verificationGap ? ' · Original bytes unavailable; import this material again.' : ''}</small></span></label>)}
            {materialCursor && <button type="button" className="text-button" onClick={() => void operate(async () => { const page = need(await window.flowmate.listResearchMaterials({ beforeId: materialCursor, limit: 30 })); setMaterials(items => [...items, ...page.items]); setMaterialCursor(page.nextBeforeId); })}>More materials</button>}
            {props.documents.map(item => <label className="research-material" key={item.documentRef.id}><input type="checkbox" checked={documentIds.includes(item.documentRef.id)} onChange={() => setDocumentIds(toggle(documentIds, item.documentRef.id))} /><span><strong>{item.displayName}</strong><small>Parsed document</small></span></label>)}
          </div>
          <p className="research-help">Only selected materials are included. Your current invoice is not added automatically.</p>
        </section>
      </div>
      <footer className="research-form-actions"><span>Create the task, then send your question in Assistant to generate a plan.</span><div className="button-row"><button type="button" className="text-button" disabled={saving} onClick={() => { setCreating(false); requestAnimationFrame(() => newResearchButton.current?.focus()); }}>Cancel</button><button className="primary-button" type="submit" disabled={!props.ready || !question.trim() || saving || webEnabled && webConfigured !== true}>Create research</button></div></footer>
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
          <label className="research-material"><input type="checkbox" role="switch" aria-label="Web search" aria-describedby="research-task-web-status"
            checked={task.sourcePolicy.web} disabled={webChangeBlocked || !task.sourcePolicy.web && webConfigured !== true}
            onChange={event => void updateWebAccess(event.target.checked)} />
            <span><strong>Web search</strong><small id="research-task-web-status">
              {webStatus}{' '}
              Changing web search keeps your selected materials and history. {regeneratePlan}
            </small></span>
          </label>
          <div className="research-tabs" role="group" aria-label="Research views">{(['Plan', 'Evidence', 'Report'] as const).map(name => <button type="button" key={name} aria-pressed={view === name} onClick={() => { setView(name); if (name === 'Report') props.onAssistant(true); }}>{name}</button>)}</div>
          {task.workflow && <section className="research-source" aria-label="Research steps"><h3>Research steps</h3>
            <p>{task.workflow.steps.filter(step => step.status === 'succeeded').length} / {task.workflow.steps.length} sources acquired</p>
            <ol>{task.workflow.steps.map((step, index) => <li key={step.id}><strong>Step {index + 1} · {step.status}</strong>
              <p>{step.questionIds.map(id => plan?.body.dimensions.flatMap(dimension => dimension.questions).find(question => question.id === id)?.question ?? id).join(' · ')}</p>
              {step.error && <p>{step.error.message}</p>}
              {step.sourceSnapshotId !== null && <button type="button" className="text-button" disabled={saving || !props.ready}
                onClick={() => { setView('Evidence'); void readEvidence(step.sourceSnapshotId!); }}>View saved source for step {index + 1}</button>}
            </li>)}</ol>
            {task.planConfirmed && plan && task.workflow.steps.some(step => ['pending', 'failed', 'interrupted'].includes(step.status)) &&
              <button type="button" className="secondary-button" disabled={!props.canRun || props.running || loading || saving}
                onClick={() => props.onRun('Continue the confirmed research plan. Reuse successful sources and acquire the remaining steps.',
                  { researchId: task.researchId, phase: 'researching', plan: { planId: plan.planId, revision: plan.revision }, continuation: true }, plan.body.execution)}>Continue research</button>}
          </section>}
          {view === 'Plan' && (plan ? <div className="research-plan">
            <div className="research-section-heading"><h3>Plan version {plan.revision}</h3><span className="research-badge">{plan.body.dimensions.length} dimensions</span></div>
            <p className="research-prose">{plan.body.question}</p><p className="research-prose research-help">{plan.body.scope}</p>
            {plan.body.dimensions.map(dimension => <section className="research-dimension" key={dimension.id}><h4>{dimension.title}</h4>{dimension.questions.map(item => <div key={item.id}><p>{item.question}</p><ul>{item.evidenceNeeded.map((text, index) => <li key={index}>{text}</li>)}</ul></div>)}</section>)}
            <details className="research-execution"><summary>Source scope, budget and stop conditions</summary>
              <h4>Source scope</h4><p>Local materials: {plan.body.sourcePolicy.artifactIds.length}; parsed documents: {plan.body.sourcePolicy.documentIds.length}. Web search: {plan.body.sourcePolicy.web ? 'on' : 'off'}.</p>
              <h4>Execution budget</h4><p>{plan.body.execution.budget.maxModelCalls} model calls; {plan.body.execution.budget.maxToolCalls} tool calls; {plan.body.execution.timeoutMs / 1000} seconds.</p>
              <h4>Stop conditions</h4><ul>{plan.body.stopConditions.map((text, index) => <li key={index}>{text}</li>)}</ul>
            </details>
            {plan.body.steps?.some(step => step.tool !== 'read_research_local') && <section className="research-source">
              <h4>Web requests to Tavily</h4><ul>{plan.body.steps.filter(step => step.tool !== 'read_research_local').map(step =>
                <li key={step.id} className="research-prose">{step.tool === 'search_research_web'
                  ? <>Search “{step.input.query}” · {step.input.timeRange ? 'past ' + step.input.timeRange : 'any publication date'} · result {step.input.rank ?? 1}</>
                  : <>Read {step.input.url}</>}</li>)}</ul>
            </section>}
            <div className="research-plan-confirm"><p className="research-help">{plan.body.sourcePolicy.artifactIds.length + plan.body.sourcePolicy.documentIds.length} authorized materials · {plan.body.execution.budget.maxModelCalls} model calls · {plan.body.execution.budget.maxToolCalls} tool calls · {plan.body.execution.timeoutMs / 1000} seconds</p><button type="button" className="primary-button" disabled={!props.canRun || task.status !== 'awaiting_confirmation' || loading || saving} onClick={() => props.onRun('I confirm research plan version ' + plan.revision + '. Investigate within its source scope and budget.',
              { researchId: task.researchId, phase: 'researching', plan: { planId: plan.planId, revision: plan.revision } }, plan.body.execution)}>Confirm plan version {plan.revision}</button><p className="research-help">Investigation starts after you confirm this version.</p></div>
            <label className="field"><span>Plan changes</span><textarea maxLength={16000} placeholder="Describe the changes you want before confirming…" value={planChanges} onChange={event => setPlanChanges(event.target.value)} /></label>
            <button type="button" className="secondary-button" disabled={!props.canRun || !planChanges.trim() || loading || saving} onClick={() => props.onRun(planChanges, { researchId: task.researchId, phase: 'planning', plan: null })}>Revise plan</button>
            <p className="research-help">Changing authorized materials requires a new research task.</p>
          </div> : <div className="research-empty"><h3>Start with a research plan</h3><p>Send your question in Assistant. Review the saved plan here before confirming the investigation.</p><button type="button" className="secondary-button" onClick={() => props.onAssistant(false)}>Open research Assistant</button></div>)}
          {view === 'Evidence' && <div className="research-evidence"><div className="research-section-heading"><h3>Saved sources</h3><span className="research-badge">{sources.length} loaded</span></div>
            {!sources.length && <p className="research-help">No source snapshots saved yet.</p>}
            {sources.map(source => <section key={source.sourceSnapshotId} className="research-source"><div className="research-section-heading"><strong>{source.title}</strong><button type="button" className="text-button" onClick={() => void readEvidence(source.sourceSnapshotId)}>View source {source.sourceSnapshotId}</button></div><p className="research-help">{source.address}{source.kind === 'web' && <> · Source date: {source.publishedAt ?? 'unknown'} · <button type="button" className="text-button" onClick={() => void openWebSource(source)}>Open webpage</button></>}{source.verificationGap ? ' · Legacy source bytes cannot be verified. Historical references are retained.' : ''}</p><details className="research-execution"><summary>Execution details</summary><p>Run {source.runId} / ToolCall {source.toolCallId} · {source.fetchedAt}{source.truncated ? ' · truncated' : ''}</p></details></section>)}
            {sourceCursor && <button type="button" className="text-button" disabled={saving} onClick={() => void operate(async () => { const page = need(await window.flowmate.listResearchSources({ researchId: task.researchId, beforeId: sourceCursor, limit: 30 })); setSources(items => [...items, ...page.items]); setSourceCursor(page.nextBeforeId); })}>More sources</button>}
            {evidence && <section className="research-source-passage" aria-label="Saved source text"><h4>{evidence.source.title}</h4><details className="research-execution"><summary>Passage details</summary><p>Offsets {evidence.excerpt.start}–{evidence.excerpt.end}</p></details><pre className="research-prose">{evidence.excerpt.quote}</pre>{evidence.nextOffset !== null && <button type="button" className="text-button" onClick={() => void readEvidence(evidence.source.sourceSnapshotId, evidence.nextOffset!)}>Next source passage</button>}</section>}
            <h3>Claim verification</h3>{claims.map(claim => <section className="research-source" key={claim.claimId}><h4>Claim {claim.claimId} · {claim.verification.status}</h4><p className="research-prose">{claim.text}</p><ul>{claim.verification.reasons.map((text, index) => <li key={index}>{text}</li>)}</ul><details className="research-execution"><summary>Dependencies</summary>{claim.dependencies.length ? claim.dependencies.map(id => <button type="button" className="text-button" key={id} onClick={() => void readClaim(id)}>Inspect dependency {id}</button>) : <p>None</p>}</details>{claim.evidence.map((item, index) => <div className="research-claim-evidence" key={index}><p>{item.relation}: {item.ref.locator.quote}</p><button type="button" className="text-button" onClick={() => void readEvidence(item.ref.sourceSnapshotId, item.ref.locator.start)}>Inspect evidence for claim {claim.claimId} / source {item.ref.sourceSnapshotId}</button></div>)}</section>)}
            {claimCursor && plan && <button type="button" className="text-button" disabled={saving} onClick={() => void operate(async () => { const page = need(await window.flowmate.listResearchClaims({ researchId: task.researchId, planId: plan.planId, beforeId: claimCursor, limit: 30 })); setClaims(items => [...items, ...page.items]); setClaimCursor(page.nextBeforeId); })}>More claims</button>}
          </div>}
          {view === 'Report' && (report ? <div className="research-report">
            <div className="research-report-toolbar" aria-label="Report actions">
              <label className="field"><span>Saved report</span><select aria-label="Saved report" disabled={saving} value={report.reportId} onChange={event => { const next = reports.find(item => item.reportId === Number(event.target.value)); if (next) { setReport(next); setMessage(null); setError(null); } }}>{reports.map(item => <option key={item.reportId} value={item.reportId}>Report {item.reportId} · plan {item.revision} · {item.completeness}</option>)}</select></label>
              <div className="research-export-action"><label className="field"><span>Export format</span><select value={format}
                onChange={event => setFormat(event.target.value === 'pdf' ? 'pdf' : 'markdown')}>
                <option value="markdown">Markdown</option><option value="pdf" disabled={!report.cited}>PDF</option>
              </select></label><span className="research-badge">{report.completeness === 'full' ? 'Complete report' : 'Partial report'}</span><button type="button" className="primary-button" disabled={saving || !props.ready} onClick={() => void operate(async () => {
                const result = need(await window.flowmate.saveResearchExport({ researchId: task.researchId, reportId: report.reportId, format }));
                setMessage(result.cancelled ? 'Save cancelled. Your report is still available here.' : 'Report saved' + (result.destinationPath ? ' to ' + result.destinationPath : '.'));
              })}>Save report</button><small>{format === 'pdf' ? 'PDF .pdf' : 'Markdown .md'} · choose a location</small></div>
              {error && <p role="alert" className="notice bad research-error">{error}</p>}
              {message && <p role="status" className="notice research-feedback">{message}</p>}
            </div>
            {reportCursor && <button type="button" className="text-button" disabled={saving} onClick={() => void operate(async () => { const page = need(await window.flowmate.listResearchReports({ researchId: task.researchId, beforeId: reportCursor, limit: 100 })); setReports(items => [...items, ...page.items.filter(next => !items.some(item => item.reportId === next.reportId))]); setReportCursor(page.nextBeforeId); })}>More reports</button>}
            <article className="research-report-body">
              <p className="research-help">Report {report.reportId} · Plan version {report.revision} · Saved {new Date(report.createdAt).toLocaleString()}</p>
              {report.cited && !activeDocument ? <p role={documentError ? 'alert' : 'status'}>{documentError ?? 'Loading saved references…'}</p> : <>
                {report.answer && <><h3>Research answer</h3><p className="research-prose research-answer">
                  {report.cited ? renderSentences(report.cited.answer) : report.answer}</p></>}
                {report.sections.map((section, index) => <section key={index}><h3>{section.title}</h3><p className="research-prose">
                  {report.cited ? renderSentences(report.cited.sections[index]!.sentences) : section.text}</p><div className="research-citations">
                  {section.claimIds.map(id => <button type="button" className="secondary-button" key={id} onClick={() => void readClaim(id)}>Inspect claim {id}</button>)}</div></section>)}
                {report.cited && !report.answer && !report.sections.length && <p className="research-help">No citable findings</p>}
                {renderSemanticReview(report)}
                {reference && renderReference(reference)}
              </>}
              <section><h3>Coverage</h3><ul className="research-coverage">{report.coverage.map(row => <li key={row.questionId}><strong>{row.questionId}</strong><span className="research-badge">{row.status}</span><p>{row.reason}</p><small>Claims: {row.claimIds.join(', ') || 'none'}</small></li>)}</ul></section>
              {([['Conflicts', report.conflicts], ['Limitations', report.limitations], ['Unresolved questions', report.unresolvedQuestions]] as const).map(([title, items]) => <section key={title}><h3>{title}</h3>{items.length ? <ul>{items.map((text, index) => <li key={index}>{text}</li>)}</ul> : <p className="research-help">None recorded.</p>}</section>)}
              {!report.cited && <p className="research-help">Historical report with section-level citations. Generate a new report to export PDF.</p>}
              <footer className="research-report-footer"><p>Continue with this research in Assistant.</p><button type="button" className="secondary-button" onClick={() => props.onAssistant(false)}>Ask follow-up</button></footer>
            </article>
          </div> : <div className="research-empty"><h3>No saved report yet</h3><p>Reports appear here after the investigation saves its findings. Partial evidence and failed source calls remain available in Evidence and Assistant.</p><button type="button" className="primary-button" disabled>Save report</button></div>)}
        </> : <div className="research-empty"><h2>A report starts with a question</h2><p>Select a saved research task or create a new one.</p></div>}
      </div>
    </div>}
  </section>;
}
