import { useEffect, useRef, useState } from 'react';
import { EvaluationPreviewRequestSchema, type EvaluationCatalog, type EvaluationComparison, type EvaluationControlState,
  type EvaluationExecutionList, type EvaluationFeedbackList, type EvaluationFeedbackTarget, type EvaluationPreview,
  type EvaluationResult, type EvaluationScoreView, type EvaluationReadPageSchema } from '../../../../packages/contracts/src/evaluation.ts';
import type { DesktopState } from '@flowmate/contracts';
import type { z } from 'zod';
import { evaluationBusy } from './evaluation-state.ts';
import { EvaluationLoop, type EvaluationTraceTarget } from './evaluation-loop.tsx';

type Catalog = Extract<EvaluationCatalog, { view: 'list' }>;
type CaseView = Extract<EvaluationCatalog, { view: 'case' }>;
type Props = { desktop: DesktopState | null; control: EvaluationControlState | null;
  traceTarget?: EvaluationTraceTarget | null; onOpenActivity?(runId: number, sessionId: number | null): void;
  revision(): number; onControl(value: EvaluationControlState, revision: number): void; onModels(): void };
const id = () => crypto.randomUUID();
const json = (value: unknown) => JSON.stringify(value, null, 2);
const errorText = (error: unknown) => error instanceof Error ? error.message : 'The response is unavailable. Refresh the original record before trying again.';

function Paging({ page, onPage, disabled }: { page: z.infer<typeof EvaluationReadPageSchema>; onPage(offset: number): void; disabled?: boolean }) {
  return <div className="evaluation-paging"><span>{page.total === 0 ? 'No entries' : `${page.offset + 1}–${Math.min(page.offset + page.limit, page.total)} of ${page.total}`} · {page.unit}</span>
    <button className="text-button" disabled={disabled || page.offset === 0} onClick={() => onPage(Math.max(0, page.offset - page.limit))}>Previous page</button>
    <button className="text-button" disabled={disabled || page.nextOffset === null} onClick={() => page.nextOffset !== null && onPage(page.nextOffset)}>Next page</button></div>;
}

function FeedbackPanel({ target, caseViewId, writable, blocked }: { target: EvaluationFeedbackTarget; caseViewId?: string; writable: boolean; blocked: boolean }) {
  const [reviewer, setReviewer] = useState(''), [note, setNote] = useState(''), [verdict, setVerdict] = useState<'good' | 'bad'>('bad');
  const [feedback, setFeedback] = useState<EvaluationFeedbackList | null>(null), [message, setMessage] = useState<string | null>(null);
  const [working, setWorking] = useState(false), gate = useRef(false), operation = useRef<string | null>(null), generation = useRef(0);
  async function read(offset = 0, operationId?: string) {
    const ticket = ++generation.current;
    try {
      const queryTarget = target.kind === 'run-feedback' ? { kind: 'run-feedback' as const, executionId: target.executionId } : target;
      const result = await window.flowmate.queryEvaluationFeedback({ target: queryTarget, offset, ...(operationId ? { operationId } : {}),
        ...(offset && feedback ? { viewId: feedback.viewId } : {}) });
      if (ticket !== generation.current) return;
      if (result.ok) { setFeedback(result.data); if (operationId) setMessage(result.data.operation ? 'Feedback saved.' : 'No saved feedback found for this operation.'); }
      else setMessage(result.error.message);
    } catch (error) { if (ticket === generation.current) setMessage(errorText(error)); }
  }
  useEffect(() => { void read(); return () => { generation.current++; }; }, []);
  async function save() {
    if (gate.current || !writable || blocked) return;
    gate.current = true; setWorking(true); setMessage(null); operation.current ??= id();
    try {
      const result = await window.flowmate.addEvaluationFeedback({ operationId: operation.current, reviewer, verdict, note,
        target: target.kind === 'case-quality' ? { ...target, caseViewId: caseViewId! } : target });
      if (result.ok) { setMessage('Feedback saved.'); operation.current = null; await read(); }
      else setMessage(result.error.message);
    } catch (error) { setMessage(errorText(error)); }
    finally { gate.current = false; setWorking(false); }
  }
  const change = (edit: () => void) => { operation.current = null; edit(); };
  return <section className="evaluation-feedback" aria-label="Local feedback"><h3>Local feedback</h3>
    <p>Reviewer identity is declared locally. Automatic scores stay unchanged. Formal acceptance remains pending.</p>
    {feedback && <><ul>{feedback.records.map(record => <li key={record.id}><strong>{record.verdict} · {record.reviewer}</strong> · {record.validity}
      <p>{record.note}{record.noteTruncated ? ' (shortened)' : ''}</p><small>{record.caseId} · {record.trialId ?? 'Case review'} · {record.id} · {record.at}</small></li>)}</ul>
      {feedback.issues.map((issue, index) => <p role="alert" key={index}>{issue}</p>)}
      <Paging page={feedback.page} onPage={offset => void read(offset)} disabled={working} /></>}
    {!writable && <p>New feedback is unavailable until the original task summary or complete scored Execution is available.</p>}
    <form onSubmit={event => { event.preventDefault(); void save(); }}><fieldset disabled={working || blocked || !writable} className="form-grid">
      <label className="field"><span>Reviewer</span><input value={reviewer} maxLength={128} required onChange={event => change(() => setReviewer(event.target.value))} /></label>
      <label className="field"><span>Verdict</span><select aria-label="Verdict" value={verdict} onChange={event => change(() => setVerdict(event.target.value === 'good' ? 'good' : 'bad'))}><option value="bad">Bad</option><option value="good">Good</option></select></label>
      <label className="field full"><span>Feedback note</span><textarea value={note} maxLength={16_000} required onChange={event => change(() => setNote(event.target.value))} /></label>
      <button className="secondary-button" type="submit">{target.kind === 'case-quality' ? 'Save Case feedback' : 'Save Trial feedback'}</button>
    </fieldset></form>
    <button className="text-button" disabled={working} onClick={() => void read(0, operation.current ?? undefined)}>{operation.current ? 'Check original feedback' : 'Refresh feedback'}</button>
    {message && <p role="status">{message}</p>}
  </section>;
}

export function EvaluationScores({ scores }: { scores: EvaluationScoreView[] }) {
  return <>{([['formal', 'Formal metric scores'], ['diagnostic', 'Additional diagnostics'], ['guardrail', 'Hard constraints'], [null, 'Legacy checks']] as const).map(([category, label]) => {
    const rows = scores.filter(score => score.category === category);
    return rows.length === 0 ? null : <section key={label} aria-label={label}><h3>{label}</h3><div className="evaluation-table-wrap"><table>
      <thead><tr><th>Metric / Evaluator</th><th>Method / status</th><th>Original statistics</th><th>Reason / evidence</th><th>Judge / calibration</th></tr></thead>
      <tbody>{rows.map((score, index) => <tr key={index}><td>{score.metricId}<small>{score.evaluatorId ?? 'legacy'} v{score.evaluatorVersion ?? score.version}</small></td>
        <td>{score.method} · {score.status}<p>{score.required ? 'Required' : 'Optional'} · {score.value ?? 'unknown'}</p></td><td><pre>{json(score.statistics ?? 'unknown')}</pre></td>
        <td>{score.reason}<p>{score.applicabilityReason}</p><small>{score.evidence.join(', ')}</small></td>
        <td>{score.judge ? <p>{score.judge.callId} · criterion {score.judge.criterion + 1}</p> : 'No submitted Judge task'}
          {score.method === 'llm-judge' ? <><p>Calibration: {score.calibration?.state ?? 'not-provided'}</p>
            {score.calibration && <><p>{score.calibration.reference ?? 'No reference'} · {score.calibration.kind ?? 'unknown source'}</p>
              <small>{score.calibration.metricIds.join(', ')}</small><p>{score.calibration.reason}</p></>}
            <small>Acceptance: {score.calibration?.acceptance ?? 'not-assessed'}</small></> : <p>Local calculation; no Judge calibration required</p>}</td></tr>)}</tbody>
    </table></div></section>;
  })}</>;
}

function SavedResult({ executionId, blocked }: { executionId: string; blocked: boolean }) {
  const [result, setResult] = useState<EvaluationResult | null>(null), [view, setView] = useState<EvaluationResult['view']>('summary');
  const [trialId, setTrialId] = useState(''), [trialOptions, setTrialOptions] = useState<EvaluationResult['trials']>([]);
  const [message, setMessage] = useState<string | null>(null), [working, setWorking] = useState(false), generation = useRef(0), gate = useRef(false);
  const [needsReceiptRead, setNeedsReceiptRead] = useState(false);
  async function read(nextView = view, nextTrial = trialId, offset = 0) {
    const ticket = ++generation.current; setMessage(null);
    try {
      const response = await window.flowmate.queryEvaluationResult({ executionId, view: nextView, ...(nextTrial ? { trialId: nextTrial } : {}), offset,
        ...(offset && result ? { viewId: result.viewId } : {}) });
      if (ticket !== generation.current) return false;
      if (!response.ok) { setMessage(response.error.message); return false; }
      setResult(response.data); setView(nextView); setTrialId(nextTrial); setNeedsReceiptRead(false);
      if (nextView === 'summary' && !nextTrial) setTrialOptions(response.data.trials);
      return true;
    } catch (error) { if (ticket === generation.current) setMessage(errorText(error)); }
    return false;
  }
  useEffect(() => { void read('summary', ''); return () => { generation.current++; }; }, []);
  async function upload() {
    if (blocked || gate.current || needsReceiptRead) return; gate.current = true; setWorking(true); setMessage(null);
    try {
      const reply = await window.flowmate.exportEvaluation({ executionId, operationId: id() });
      if (!reply.ok) {
        setMessage(reply.error.message);
        if (['evaluation_response_unknown', 'evaluation_worker_exited', 'evaluation_write_failed', 'evaluation_protocol_invalid', 'evaluation_export_failed'].includes(reply.error.code))
          setNeedsReceiptRead(true);
      }
      else if (await read()) setMessage('Export receipt refreshed.');
      else setNeedsReceiptRead(true);
    } catch (error) { setMessage(errorText(error)); setNeedsReceiptRead(true); }
    finally { gate.current = false; setWorking(false); }
  }
  const summary = result?.summary, selectedTrial = trialOptions.find(trial => trial.trialId === trialId);
  return <section className="panel evaluation-result" aria-label="Saved execution"><div className="panel-head"><h2>{executionId}</h2>
    <button className="text-button" onClick={() => void read()} disabled={working}>Refresh saved result</button></div>
    {message && <p role="status">{message}</p>}
    {result && <><div className="evaluation-facts"><span>Execution: {summary!.executionComplete ? 'complete' : 'incomplete'}</span>
      <span>Scoring: {summary!.scoring}</span><span>Feedback: separate local records</span><span>Export: {summary!.export?.status ?? 'unknown'}</span></div>
      <p>{summary!.dataset.id} v{summary!.dataset.version} · {summary!.plannedTrials} planned Trials · {summary!.environment}</p>
      <details><summary>Original execution conditions</summary>{summary!.conditions ? <pre>{json(summary!.conditions)}</pre> : <p>Original conditions: {summary!.conditionsIssue ?? 'unknown'}.</p>}</details>
      {result.sourceInvalidation && <p role="alert">{result.sourceInvalidation.reason} · {result.sourceInvalidation.paths.join(', ')}</p>}
      {result.gaps.length > 0 && <ul aria-label="Evidence gaps">{result.gaps.map((gap, index) => <li key={index}>{gap.kind}: {gap.reason} · {gap.reference}</li>)}</ul>}
      <div className="form-grid"><label className="field"><span>Result view</span><select aria-label="Result view" value={view} onChange={event => void read(event.target.value as EvaluationResult['view'], trialId)}>
        {(['summary', 'scores', 'observations', 'events', 'artifacts'] as const).map(name => <option key={name}>{name}</option>)}</select></label>
        <label className="field"><span>Trial</span><select aria-label="Trial" value={trialId} onChange={event => void read(view, event.target.value)}><option value="">All Trials</option>
          {trialOptions.map(trial => <option value={trial.trialId} key={trial.trialId}>{trial.caseId} · repetition {trial.repetition}</option>)}</select></label></div>
      {view === 'summary' && !trialId && <div className="evaluation-table-wrap"><table><thead><tr><th>Case / Trial</th><th>Execution</th><th>Grade</th><th>Judge calls</th><th>Usage</th></tr></thead>
        <tbody>{result.trials.map(trial => <tr key={trial.trialId}><td><button className="text-button" onClick={() => void read('scores', trial.trialId)}>{trial.caseId} · {trial.repetition}</button><small>{trial.trialId}</small></td>
          <td>{trial.executionStatus ?? 'unknown'}</td><td>{trial.status}<p>{trial.reason}</p></td><td>{trial.judgeGenerations ?? 'unknown'}</td><td><pre>{json(trial.usage ?? 'unknown')}</pre><span>Cost: unknown unless saved in usage.</span></td></tr>)}</tbody></table></div>}
      {view === 'scores' && <EvaluationScores scores={result.scores} />}
      {result.text && <pre className="evaluation-text">{result.text}</pre>}
      <Paging page={result.page} onPage={offset => void read(view, trialId, offset)} disabled={working} />
      {result.metrics && <details><summary>39 formal metrics · original aggregates</summary><pre>{json(result.metrics)}</pre></details>}
      <details><summary>Platform receipt</summary><pre>{json(summary!.export ?? 'unknown')}</pre>
        <p>Upload and resend use this saved Execution. Viewing and refresh do not send platform events.</p>
        {needsReceiptRead && <p>Refresh the saved result to read the original receipt before another upload.</p>}
        <button className="secondary-button" onClick={() => void upload()} disabled={working || blocked || needsReceiptRead || !summary!.endedAt || summary!.scoring !== 'complete' || summary!.evidenceComplete !== true}>Upload / resend saved report</button></details>
      {selectedTrial && <FeedbackPanel key={selectedTrial.trialId} target={{ kind: 'run-feedback', executionId, caseId: selectedTrial.caseId, trialId: selectedTrial.trialId }}
        blocked={blocked || working} writable={!!summary!.endedAt && summary!.scoring === 'complete' && summary!.evidenceComplete === true} />}
    </>}
  </section>;
}

function CompareResults({ items }: { items: EvaluationExecutionList['items'] }) {
  const [left, setLeft] = useState(''), [right, setRight] = useState(''), [comparison, setComparison] = useState<EvaluationComparison | null>(null);
  const [message, setMessage] = useState<string | null>(null), [originals, setOriginals] = useState<EvaluationResult['summary'][]>([]), sequence = useRef(0);
  useEffect(() => () => { sequence.current++; }, []);
  async function compare() {
    const ticket = ++sequence.current; setComparison(null); setOriginals([]); setMessage(null);
    try {
      const result = await window.flowmate.compareEvaluation({ left, right }); if (ticket !== sequence.current) return;
      if (result.ok) setComparison(result.data);
      else {
        setMessage(result.error.message);
        const values = await Promise.all([left, right].map(executionId => window.flowmate.queryEvaluationResult({ executionId, view: 'summary' })));
        if (ticket === sequence.current) setOriginals(values.flatMap(value => value.ok ? [value.data.summary] : []));
      }
    } catch (error) { if (ticket === sequence.current) setMessage(errorText(error)); }
  }
  return <details className="panel evaluation-comparison"><summary>Compare saved executions</summary><div className="form-grid">
    {(['left', 'right'] as const).map(side => <label className="field" key={side}><span>{side === 'left' ? 'Before Execution' : 'After Execution'}</span>
      <select aria-label={side === 'left' ? 'Before Execution' : 'After Execution'} value={side === 'left' ? left : right} onChange={event => { sequence.current++; setComparison(null); setOriginals([]); setMessage(null); (side === 'left' ? setLeft : setRight)(event.target.value); }}><option value="">Choose saved Execution</option>
        {items.map(item => <option key={item.executionId} value={item.executionId}>{item.executionId}</option>)}</select></label>)}
    <button className="secondary-button" disabled={!left || !right || left === right} onClick={() => void compare()}>Compare conditions and results</button></div>
    {message && <p role="status">{message} Different conditions can be viewed side by side; these results do not establish a quality improvement.</p>}
    {comparison && <pre>{json(comparison.rows)}</pre>}{originals.length > 0 && <div className="evaluation-originals">{originals.map(summary => <pre key={summary.executionId}>{json(summary)}</pre>)}</div>}
  </details>;
}

export function EvaluationPage({ desktop, control, revision, onControl, onModels, traceTarget, onOpenActivity }: Props) {
  const [catalog, setCatalog] = useState<Catalog | null>(null), [executions, setExecutions] = useState<EvaluationExecutionList | null>(null);
  const [datasetId, setDatasetId] = useState('all'), [selection, setSelection] = useState('smoke'), [caseId, setCaseId] = useState('');
  const [repeat, setRepeat] = useState('1'), [judge, setJudge] = useState('auto'), [limits, setLimits] = useState<Record<string, string>>({});
  const [environment, setEnvironment] = useState('');
  const [preview, setPreview] = useState<EvaluationPreview | null>(null), [inspected, setInspected] = useState<CaseView | null>(null);
  const [selectedExecution, setSelectedExecution] = useState(''), [message, setMessage] = useState<string | null>(null);
  const [working, setWorking] = useState(false), gate = useRef(false), generation = useRef(0), readSequence = useRef(0), historySequence = useRef(0);
  const blocked = evaluationBusy(control);
  const datasets = [...new Map(catalog?.items.map(item => [item.datasetId, { id: item.datasetId, version: item.datasetVersion }]) ?? []).values()];
  const cases = catalog?.items.filter(item => item.datasetId === datasetId) ?? [];
  const change = (edit: () => void) => { generation.current++; setPreview(null); setInspected(null); setMessage(null); edit(); };
  async function catalogRead(offset = 0) {
    const ticket = ++readSequence.current;
    try {
      const result = await window.flowmate.queryEvaluationCatalog({ view: 'list', offset, limit: 200, ...(offset && catalog ? { viewId: catalog.viewId } : {}) });
      if (ticket !== readSequence.current) return;
      if (result.ok && result.data.view === 'list') setCatalog(result.data); else if (!result.ok) setMessage(result.error.message);
    } catch (error) { if (ticket === readSequence.current) setMessage(errorText(error)); }
  }
  async function historyRead(offset = 0) {
    const ticket = ++historySequence.current;
    try {
      const result = await window.flowmate.listEvaluationExecutions({ offset, ...(offset && executions ? { viewId: executions.viewId } : {}) });
      if (ticket !== historySequence.current) return;
      if (result.ok) setExecutions(result.data); else setMessage(result.error.message);
    } catch (error) { if (ticket === historySequence.current) setMessage(errorText(error)); }
  }
  async function controlRead(ticket = generation.current) {
    const current = revision();
    try {
      const result = await window.flowmate.queryEvaluationControl();
      if (ticket !== generation.current) return false;
      if (result.ok) { onControl(result.data, current); return true; }
      setMessage(result.error.message);
    } catch (error) { if (ticket === generation.current) setMessage(errorText(error)); }
    return false;
  }
  useEffect(() => { void catalogRead(); void historyRead(); void controlRead(); return () => { generation.current++; readSequence.current++; historySequence.current++; }; }, []);
  useEffect(() => {
    if (preview && desktop && desktop.settings.revision > preview.settings.revision) {
      generation.current++; setPreview(null); setMessage('Evaluation model settings changed. Preview again.');
    }
  }, [desktop?.settings.revision, preview?.settings.revision]);
  async function action(work: () => Promise<void>) {
    if (gate.current) return; gate.current = true; setWorking(true); setMessage(null);
    try { await work(); } catch (error) { setMessage(errorText(error)); }
    finally { gate.current = false; setWorking(false); }
  }
  async function inspect(offset = 0) {
    const ticket = generation.current;
    const result = await window.flowmate.queryEvaluationCatalog({ view: 'case', datasetId, caseId, offset,
      ...(offset && inspected ? { caseViewId: inspected.caseViewId } : {}) });
    if (ticket !== generation.current) return;
    if (result.ok && result.data.view === 'case') setInspected(result.data); else if (!result.ok) setMessage(result.error.message);
  }
  async function makePreview() {
    const ticket = generation.current, numbers = Object.fromEntries(Object.entries(limits).filter(([, value]) => value.trim()).map(([key, value]) => [key, Number(value)]));
    const { timeoutMs, trialTimeoutMs, stopGraceMs, ...budget } = numbers;
    const request = EvaluationPreviewRequestSchema.safeParse({ datasetId, selection, ...(selection === 'case' ? { caseId } : {}), repeat: Number(repeat), judge,
      configuration: { ...(timeoutMs === undefined ? {} : { timeoutMs }), ...(stopGraceMs === undefined ? {} : { stopGraceMs }),
        ...(trialTimeoutMs === undefined ? {} : { trialTimeoutMs }),
        ...(environment.trim() ? { environment: environment.trim() } : {}), ...(Object.keys(budget).length ? { budget } : {}) } });
    if (!request.success) { setMessage('Check the registered Dataset, Case, repetition count and run limits.'); return; }
    const result = await window.flowmate.previewEvaluation(request.data); if (ticket !== generation.current) return;
    if (!result.ok) { setMessage(result.error.message); return; }
    if (await controlRead(ticket) && ticket === generation.current) setPreview(result.data);
  }
  async function start() {
    if (!preview?.ready || blocked) return;
    const request = { previewId: preview.previewId, requestId: id() }, current = revision(), ticket = generation.current; setPreview(null);
    try {
      const result = await window.flowmate.startEvaluation(request);
      if (ticket !== generation.current) return;
      if (result.ok) onControl(result.data, current); else setMessage(result.error.message);
    } catch (error) { if (ticket !== generation.current) return; setMessage(errorText(error)); }
    const queryRevision = revision(), refreshed = await window.flowmate.queryEvaluationControl({ requestId: request.requestId });
    if (ticket !== generation.current) return;
    if (refreshed.ok) onControl(refreshed.data, queryRevision);
  }
  return <section className="page-content evaluation-page"><div className="page-heading"><div><h1>Evaluation</h1><p>Run registered tasks and review their saved evidence.</p></div>
    <button className="secondary-button" onClick={onModels}>Configure evaluation models</button></div>
    {message && <div className="notice bad" role="status">{message}</div>}
    <EvaluationLoop blocked={blocked || working} traceTarget={traceTarget} productRoot={desktop?.userDataPath} onOpenActivity={onOpenActivity} onOpenExecution={setSelectedExecution} />
    <div className="evaluation-layout"><aside className="panel evaluation-history"><div className="panel-head"><h2>Saved executions</h2>
      <button className="text-button" onClick={() => void historyRead()}>Refresh history</button></div>
      {!executions && <p>Loading saved executions…</p>}{executions?.items.length === 0 && <p>No saved executions yet.</p>}
      {executions?.items.map(item => <div key={item.executionId}><button className="text-button" onClick={() => setSelectedExecution(item.executionId)} aria-pressed={selectedExecution === item.executionId}>{item.executionId}</button>
        <small>{item.summary ? `${item.summary.dataset.id} · ${item.summary.scoring}` : item.error}</small></div>)}
      {executions && <Paging page={executions.page} onPage={offset => void historyRead(offset)} />}</aside>
      <div className="evaluation-main"><section className="panel"><div className="panel-head"><h2>Run setup</h2><button className="text-button" onClick={() => void catalogRead()}>Refresh catalog</button></div>
        <p>39 formal metrics · 55 Evaluator definitions (25 deterministic / derived + 30 independent semantic) · 0–1 logical Judge tasks per Trial.</p>
        {catalog?.items.length === 0 && <p>No registered tasks are available.</p>}
        <fieldset className="form-grid" disabled={blocked || working}><label className="field"><span>Dataset</span><select aria-label="Dataset" value={datasetId} onChange={event => change(() => { setDatasetId(event.target.value); setCaseId(''); })}>
          <option value="all">All baseline datasets</option>{datasets.map(dataset => <option key={dataset.id} value={dataset.id}>{dataset.id} · v{dataset.version}</option>)}</select></label>
          <label className="field"><span>Selection</span><select aria-label="Selection" value={selection} onChange={event => change(() => setSelection(event.target.value))}><option value="smoke">Smoke</option><option value="full">Full</option><option value="case">Single Case</option></select></label>
          {selection === 'case' && <label className="field full"><span>Case</span><select aria-label="Case" value={caseId} onChange={event => change(() => setCaseId(event.target.value))}><option value="">Choose a Case from one Dataset</option>{cases.map(task => <option value={task.caseId} key={task.caseId}>{task.caseId} · {task.name}</option>)}</select></label>}
          <label className="field"><span>Repetitions per Case</span><input type="number" min={1} max={20} value={repeat} onChange={event => change(() => setRepeat(event.target.value))} /></label>
          <label className="field"><span>Judge mode</span><select aria-label="Judge mode" value={judge} onChange={event => change(() => setJudge(event.target.value))}><option value="auto">Auto</option><option value="required">Required when applicable</option><option value="off">Off · required unmeasured stays unmet</option></select></label>
          <label className="field full"><span>Environment</span><input value={environment} maxLength={80} placeholder="Shared default" spellCheck={false}
            onChange={event => change(() => setEnvironment(event.target.value))} /></label>
          <details className="field full"><summary>Run limits</summary><div className="form-grid">{[['maxModelCalls', 'Model requests'], ['maxToolCalls', 'Tool calls'], ['toolTimeoutMs', 'Tool timeout (ms)'], ['trialTimeoutMs', 'Trial timeout (ms)'], ['timeoutMs', 'Agent run timeout (ms)'], ['stopGraceMs', 'Stop wait (ms)']].map(([key, label]) =>
            <label className="field" key={key}><span>{label}</span><input type="number" min={1} step={1} value={limits[key!] ?? ''} placeholder="Shared default" onChange={event => change(() => setLimits({ ...limits, [key!]: event.target.value }))} /></label>)}</div></details>
          <button className="secondary-button" disabled={!catalog?.items.length} onClick={() => void action(makePreview)}>Preview evaluation</button>
          <button className="text-button" disabled={selection !== 'case' || !caseId || datasetId === 'all'} onClick={() => void action(() => inspect())}>Inspect Case</button>
        </fieldset>{catalog && <Paging page={catalog.page} onPage={offset => void catalogRead(offset)} disabled={working} />}
        {preview && <section aria-label="Evaluation preview"><h3>Run preview</h3><p>{preview.plan.caseCount} Cases · {preview.plan.total} Trials · Judge calls: at most {preview.plan.judgeMaxGenerations}</p>
          <p>Cost: unknown. Backend: local. Required Judge: {preview.plan.judgeRequired ? 'yes' : 'no'}.</p>
          <p>Native model capabilities are resolved on explicit startup. No model or platform request is made by this preview.</p>
          <details><summary>Resolved evaluation budgets</summary>
            {preview.plan.configuration.evaluationBudgets && <pre>{json(preview.plan.configuration.evaluationBudgets)}</pre>}
            <div className="evaluation-table-wrap"><table aria-label="Evaluation budgets by Case"><thead><tr><th>Case / profile</th><th>Trial timeout</th><th>Agent run timeout</th><th>Model requests</th><th>Prepare / capture</th><th>Stop wait / source</th></tr></thead>
              <tbody>{preview.plan.datasets.flatMap(dataset => dataset.cases.map(task => <tr key={dataset.id + '/' + task.caseId}><td>{task.caseId}<p>{task.evaluationBudget?.profile ?? 'unknown'}</p></td>
                <td>{task.evaluationBudget ? task.evaluationBudget.trialTimeoutMs + ' ms' : 'unknown'}</td><td>{task.evaluationBudget ? task.evaluationBudget.runTimeoutMs + ' ms' : 'unknown'}</td>
                <td>{task.evaluationBudget?.maxModelCalls ?? 'unknown'}</td><td>{task.evaluationBudget ? task.evaluationBudget.prepareTimeoutMs + ' / ' + task.evaluationBudget.captureTimeoutMs + ' ms' : 'unknown'}</td>
                <td>{task.evaluationBudget ? task.evaluationBudget.stopGraceMs + ' ms / ' + task.evaluationBudget.source : 'unknown'}</td></tr>))}</tbody></table></div>
          </details>
          {preview.issues.map((issue, index) => <p role="alert" key={index}>{issue}</p>)}<details><summary>Members, scoring and run conditions</summary><pre>{json({ plan: preview.plan, models: preview.settings })}</pre></details></section>}
        <button className="primary-button" disabled={!preview?.ready || blocked || working} onClick={() => void action(start)}>Start evaluation</button>
      </section>
      {control && <section className="panel" aria-label="Evaluation progress"><div className="panel-head"><h2>Current batch</h2><button className="text-button" onClick={() => void controlRead()}>Refresh progress</button></div>
        <p>{control.state} · {control.outcome ?? 'no final outcome'} · stop: {control.stop}</p><small>{control.batchId}</small>
        {control.progress?.phase === 'capturing' && <p>采集证据</p>}<pre>{json(control.progress)}</pre>
        {control.errors.map((error, index) => <p role="alert" key={index}>{error}</p>)}{control.executionIds.map(executionId => <button className="text-button" key={executionId} onClick={() => setSelectedExecution(executionId)}>Open {executionId}</button>)}</section>}
      {inspected && <section className="panel" aria-label="Case inspection"><div className="panel-head"><h2>{inspected.name}</h2><button className="text-button" onClick={() => void action(() => inspect())}>Refresh Case</button></div>
        <p>{inspected.caseId} · v{inspected.caseVersion} · {inspected.fileCount} available files</p><pre className="evaluation-text">{inspected.summary}</pre>
        {inspected.summaryTruncated && <p role="alert">Task summary is shortened. Complete task requirements are required before new feedback.</p>}
        {inspected.gaps.map((gap, index) => <p key={index}>{gap.path}: {gap.reason}</p>)}<details><summary>Declaration, Gold and available materials</summary><pre className="evaluation-text">{inspected.text}</pre></details>
        <Paging page={inspected.page} onPage={offset => void action(() => inspect(offset))} disabled={working} /><p>Unloaded pages have not been displayed. Known missing materials can be reviewed.</p>
        <FeedbackPanel key={inspected.caseViewId} target={{ kind: 'case-quality', datasetId: inspected.datasetId, caseId: inspected.caseId }} caseViewId={inspected.caseViewId}
          writable={!inspected.summaryTruncated} blocked={blocked || working} /></section>}
      {selectedExecution && <SavedResult key={selectedExecution} executionId={selectedExecution} blocked={blocked || working} />}
      {executions && <CompareResults items={executions.items} />}
    </div></div>
  </section>;
}
