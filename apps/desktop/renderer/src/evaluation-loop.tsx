import { useEffect, useRef, useState } from 'react';
import { EvaluationCandidateRecordSchema, EvaluationWorkflowRequestSchema, isWorkflowReadOnly, type WorkflowRecordReference,
  type EvaluationWorkflowRequest as Request, type EvaluationWorkflowResult as Response } from '../../../../packages/contracts/src/evaluation-workflow.ts';
import type { z } from 'zod';

type Settings = Extract<Response, { action: 'settings.get' | 'settings.save' }>['data'];
type Trace = Extract<Response, { action: 'trace.show' }>['data']['trace'];
type Candidate = Extract<Response, { action: 'candidate.show' | 'candidate.edit' }>['data']['candidate'];
type FullCandidate = z.infer<typeof EvaluationCandidateRecordSchema>;
type RecordChunk = Extract<Response, { action: 'record.read' }>['data']['record'];
type ListPage = NonNullable<Extract<Response, { action: 'trace.list' }>['data']['page']>;
type RecordIdentity = Pick<WorkflowRecordReference, 'kind' | 'id' | 'part' | 'experimentId'>;
type Experiment = Extract<Response, { action: 'experiment.show' | 'experiment.run' }>['data']['experiment'];
export type EvaluationTraceTarget = { runId: number; sessionId: number | null };
const json = (value: unknown) => JSON.stringify(value, null, 2);
const uuid = () => crypto.randomUUID();
const editable = (candidate: FullCandidate) => Object.fromEntries(['case', 'gold', 'review', 'scenario', 'bindings', 'controls',
  'controlBindings', 'reason', 'sourceLabels', 'reuseCaseId', 'reviseCase'].filter(key => Object.hasOwn(candidate, key)).map(key => [key, Reflect.get(candidate, key)]));
function parseObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Enter a JSON object.');
  return value as Record<string, unknown>;
}
function originalRead(request: Request): Request {
  switch (request.action) {
    case 'settings.save': return { action: 'settings.get' };
    case 'candidate.edit': case 'candidate.validate': return { action: 'candidate.show', candidateId: request.candidateId };
    case 'experiment.run': return { action: 'experiment.show', experimentId: String(request.plan.id) };
    case 'baseline.create': return { action: 'baseline.list' };
    case 'gate.check': case 'experiment.compare': return { action: 'experiment.show', experimentId: request.experimentId };
    default: return request;
  }
}

export function EvaluationLoop({ blocked, traceTarget, productRoot, onOpenActivity, onOpenExecution }: { blocked: boolean; traceTarget?: EvaluationTraceTarget | null; productRoot?: string;
  onOpenActivity?(runId: number, sessionId: number | null): void; onOpenExecution?(executionId: string): void }) {
  const [view, setView] = useState<'traces' | 'candidates' | 'experiments'>('traces');
  const [settings, setSettings] = useState<Settings | null>(null), [switches, setSwitches] = useState({ capture: false, upload: false, mining: false });
  const [message, setMessage] = useState(''), [result, setResult] = useState<Response | null>(null), [busy, setBusy] = useState('');
  const [unknown, setUnknown] = useState<Request | null>(null), writeGate = useRef(false), mounted = useRef(true);
  const [traces, setTraces] = useState<Trace[]>([]), [trace, setTrace] = useState<Trace | null>(null);
  const [tracePage, setTracePage] = useState<{ page: ListPage; viewId: string } | null>(null), [candidatePage, setCandidatePage] = useState<typeof tracePage>(null);
  const [traceFilter, setTraceFilter] = useState<Extract<Request, { action: 'trace.list' }>['source']>();
  const [platformSnapshot, setPlatformSnapshot] = useState<Extract<Response, { action: 'trace.show' }>['data']['platformSnapshot']>(null);
  const [traceIdInput, setTraceIdInput] = useState(''), [candidateIdInput, setCandidateIdInput] = useState('');
  const [entry, setEntry] = useState(''), [status, setStatus] = useState(''), [remoteId, setRemoteId] = useState('');
  const [from, setFrom] = useState(() => new Date(Date.now() - 3_600_000).toISOString()), [to, setTo] = useState(() => new Date().toISOString());
  const [kind, setKind] = useState<'gold' | 'bad' | 'regression'>('bad');
  const [candidates, setCandidates] = useState<Candidate[]>([]), [candidate, setCandidate] = useState<Candidate | null>(null);
  const [patch, setPatch] = useState('{}'), [replay, setReplay] = useState(false);
  const [fullCandidate, setFullCandidate] = useState<FullCandidate | null>(null), [editorLoading, setEditorLoading] = useState(false);
  const [editSection, setEditSection] = useState('case');
  const [recordChunk, setRecordChunk] = useState<RecordChunk | null>(null), [recordBusy, setRecordBusy] = useState(false), recordGeneration = useRef(0);
  const [recordError, setRecordError] = useState('');
  const [recordKind, setRecordKind] = useState<RecordIdentity['kind']>('trace'), [recordId, setRecordId] = useState(''), [recordExperimentId, setRecordExperimentId] = useState('');
  const [recordOffset, setRecordOffset] = useState('0');
  const [reviewer, setReviewer] = useState(''), [note, setNote] = useState(''), [verdict, setVerdict] = useState<'approve' | 'reject' | 'needs-work'>('needs-work');
  const [traceVerdict, setTraceVerdict] = useState<'good' | 'bad'>('bad');
  const [benchmark, setBenchmark] = useState(''), [approval, setApproval] = useState(''), [smokeIds, setSmokeIds] = useState('');
  const [plan, setPlan] = useState(() => json({ id: 'model-comparison-' + uuid(), benchmark: { id: 'baseline', revision: 1, selection: 'smoke' },
    repeats: 1, environment: 'development', axes: ['model'], control: { id: 'sol', model: { model: 'gpt-6.1-sol',
      api: 'openai-completions', baseUrl: 'http://127.0.0.1:8767/v1', reasoning: 'max' } }, candidates: [{ id: 'luna', model: {
      model: 'gpt-6-luna', api: 'openai-completions', baseUrl: 'http://127.0.0.1:8767/v1', reasoning: 'max' } }] }));
  const [previewedPlan, setPreviewedPlan] = useState<string | null>(null), [experiments, setExperiments] = useState<Experiment[]>([]);
  const [experiment, setExperiment] = useState<Experiment | null>(null), [experimentId, setExperimentId] = useState('');
  const [armId, setArmId] = useState('luna'), [baselineId, setBaselineId] = useState(''), [fullRelease, setFullRelease] = useState(false);
  const disabled = blocked || !!busy || !!unknown;
  const workspaceUnavailable = settings?.workspace?.available === false;
  const writeDisabled = disabled || !settings || workspaceUnavailable;

  function accept(value: Response) {
    setResult(value);
    switch (value.action) {
      case 'settings.get': case 'settings.save': setSettings(value.data); setSwitches(value.data.settings); break;
      case 'trace.list': case 'trace.pull': setTraces(value.data.items); setTracePage(value.data.page && value.data.viewId ? { page: value.data.page, viewId: value.data.viewId } : null); break;
      case 'trace.show': recordGeneration.current++; setRecordBusy(false); setRecordError(''); setRecordChunk(null); setTrace(value.data.trace); setPlatformSnapshot(value.data.platformSnapshot); break;
      case 'candidate.list': setCandidates(value.data.items); setCandidatePage(value.data.page && value.data.viewId ? { page: value.data.page, viewId: value.data.viewId } : null); break;
      case 'candidate.show': {
        recordGeneration.current++; setRecordBusy(false); setRecordError(''); setEditorLoading(false); setRecordChunk(null); setCandidate(value.data.candidate); setFullCandidate(null); setPatch('{}');
        const latest = value.data.feedback?.filter(item => item.source === 'human' && item.target.revision === value.data.candidate.revision).at(-1);
        setApproval(latest?.verdict === 'approve' ? latest.id : ''); break;
      }
      case 'candidate.edit': setCandidate(value.data.candidate); setFullCandidate(null); setPatch('{}'); setApproval(''); break;
      case 'candidate.review': if (value.data.feedback.verdict === 'approve') setApproval(value.data.feedback.id); break;
      case 'trace.upload': setTrace(current => current && 'projection' in current && current.id === value.data.operation.traceId
        ? { ...current, uploadEligible: false, uploadReason: 'Original upload operation ' + value.data.operation.operationId + ' is saved. Recheck that receipt; do not create a new upload.' } : current); break;
      case 'experiment.list': setExperiments(value.data.items); break;
      case 'experiment.run': case 'experiment.show': setExperiment(value.data.experiment); setExperimentId(value.data.experiment.id); break;
      case 'experiment.preview': setPreviewedPlan(plan); break;
    }
  }
  async function invoke(input: Request, readBack = false): Promise<Response | null> {
    const readOnly = isWorkflowReadOnly(input.action);
    if (!readOnly && workspaceUnavailable) { setMessage(settings?.workspace?.reason ?? 'Repository workspace unavailable.'); return null; }
    if (!readOnly && !readBack && (writeGate.current || blocked || unknown)) return null;
    if (!readOnly) { writeGate.current = true; setBusy(input.action); }
    if (mounted.current) setMessage('');
    try {
      const checked = EvaluationWorkflowRequestSchema.safeParse(input);
      if (!checked.success) throw Error(checked.error.issues.map(issue => issue.message).join('; '));
      const reply = await window.flowmate.runEvaluationWorkflow(checked.data);
      if (!mounted.current) return null;
      if (!reply.ok) {
        setMessage(reply.error.message);
        if (!readOnly && /unknown|exited|write_failed|protocol_invalid/.test(reply.error.code)) setUnknown(input);
        return null;
      }
      accept(reply.data);
      setMessage(`${reply.data.action}: exit ${reply.data.exitCode}. Read the actual status and evidence below.`);
      if (reply.data.action === 'mine' && reply.data.data.operation.status === 'unknown'
        || reply.data.action === 'trace.upload' && reply.data.data.operation.status !== 'verified'
        || reply.data.action === 'trace.process' && (reply.data.data.mining.stopConfirmed === false || reply.data.data.mining.status === 'unknown')) setUnknown(input);
      else if (readBack && reply.data.exitCode === 0) setUnknown(null);
      return reply.data;
    } catch (error) {
      if (mounted.current) setMessage(error instanceof Error ? error.message : 'Response unavailable; inspect the original record.');
      return null;
    } finally { if (!readOnly) { writeGate.current = false; if (mounted.current) setBusy(''); } }
  }
  async function withJSON(work: () => Request) {
    try { await invoke(work()); } catch (error) { setMessage(error instanceof Error ? error.message : 'Invalid JSON.'); }
  }
  async function chunk(reference: RecordIdentity, offset = 0, viewId?: string) {
    const reply = await window.flowmate.runEvaluationWorkflow({ action: 'record.read', kind: reference.kind, id: reference.id, part: reference.part,
      ...(reference.experimentId ? { experimentId: reference.experimentId } : {}), offset, limit: 32000, ...(viewId ? { viewId } : {}) });
    if (!reply.ok) throw Error(reply.error.message);
    if (reply.data.action !== 'record.read') throw Error('The original record reply has a different identity.');
    return reply.data.data.record;
  }
  async function readRecord(reference: RecordIdentity, offset = 0, viewId?: string) {
    const ticket = ++recordGeneration.current; setRecordBusy(true); setRecordError('');
    try { const value = await chunk(reference, offset, viewId); if (ticket === recordGeneration.current) setRecordChunk(value); }
    catch (error) { if (ticket === recordGeneration.current) setRecordError(error instanceof Error ? error.message : 'Original record unavailable.'); }
    finally { if (ticket === recordGeneration.current) setRecordBusy(false); }
  }
  async function loadCandidate() {
    if (!candidate || !('record' in candidate)) return;
    const selected = candidate, ticket = ++recordGeneration.current; setEditorLoading(true); setFullCandidate(null); setRecordError('');
    try {
      const parts: string[] = []; let offset = 0, viewId: string | undefined;
      while (true) {
        const value = await chunk(selected.record, offset, viewId);
        if (ticket !== recordGeneration.current) return;
        if (value.redacted || value.revision !== selected.revision || value.page.offset !== offset || viewId && value.viewId !== viewId)
          throw Error('The candidate original is redacted, incomplete or changed. Editing remains disabled.');
        parts.push(value.text); viewId = value.viewId; setRecordChunk(value);
        if (value.page.nextOffset === null) {
          const text = parts.join(''); if (text.length !== value.page.total) throw Error('Candidate chunks are incomplete.');
          const original = EvaluationCandidateRecordSchema.parse(JSON.parse(text));
          if (original.id !== selected.id || original.revision !== selected.revision) throw Error('Candidate identity changed.');
          setFullCandidate(original); const section = original.case ? 'case' : 'reason'; setEditSection(section);
          setPatch(json({ [section]: Reflect.get(original, section) })); break;
        }
        offset = value.page.nextOffset;
      }
    } catch (error) { if (ticket === recordGeneration.current) setRecordError(error instanceof Error ? error.message : 'Complete original unavailable.'); }
    finally { if (ticket === recordGeneration.current) setEditorLoading(false); }
  }
  function savePatch(): Request {
    if (!candidate || !fullCandidate || fullCandidate.id !== candidate.id || fullCandidate.revision !== candidate.revision)
      throw Error('Load the complete current candidate before editing.');
    const edited = parseObject(patch), original = editable(fullCandidate);
    const changed = Object.fromEntries(Object.entries(edited).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(original[key])));
    if (!Object.keys(changed).length) throw Error('No changed fields to save.');
    const request: Request = { action: 'candidate.edit', candidateId: candidate.id, expectedRevision: candidate.revision, patch: changed };
    if (new TextEncoder().encode(JSON.stringify(request)).length > 512 * 1024)
      throw Error('The changed field exceeds desktop transport capacity. Use CLI candidate edit --file with the complete JSON. No truncated data was sent.');
    return request;
  }
  function collectionPaging(action: 'trace.list' | 'candidate.list', value: typeof tracePage) {
    if (!value) return null;
    const request = (offset: number): Request => action === 'trace.list' ? { action, offset, viewId: value.viewId, ...(traceFilter ? { source: traceFilter } : {}) }
      : { action, offset, viewId: value.viewId };
    return <div><span>{value.page.total ? value.page.offset + 1 : 0}–{Math.min(value.page.offset + value.page.limit, value.page.total)} of {value.page.total} saved summaries</span>
      <button className="text-button" disabled={!value.page.offset} onClick={() => void invoke(request(Math.max(0, value.page.offset - value.page.limit)))}>Previous summaries</button>
      <button className="text-button" disabled={value.page.nextOffset === null} onClick={() => value.page.nextOffset !== null && void invoke(request(value.page.nextOffset))}>Next summaries</button></div>;
  }
  useEffect(() => {
    mounted.current = true; void invoke({ action: 'settings.get' }); void invoke({ action: 'trace.list' });
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!traceTarget) return;
    let current = true; setView('traces'); setTrace(null);
    const source = { kind: 'product' as const, ...(productRoot ? { productRoot } : {}), runId: String(traceTarget.runId),
      ...(traceTarget.sessionId === null ? {} : { sessionId: String(traceTarget.sessionId) }) };
    setTraceFilter(source);
    void window.flowmate.runEvaluationWorkflow({ action: 'trace.list', source }).then(reply => {
      if (!current || !mounted.current) return;
      if (!reply.ok) { setMessage(reply.error.message); return; }
      if (reply.data.action !== 'trace.list') return;
      const matches = reply.data.data.items.filter(item => item.source.kind === 'product' && !!productRoot && item.source.productRoot === productRoot
        && item.source.runId === String(traceTarget.runId)
        && (traceTarget.sessionId === null || item.source.sessionId === undefined || item.source.sessionId === String(traceTarget.sessionId)));
      setTraces(matches);
      setTracePage(reply.data.data.page && reply.data.data.viewId ? { page: reply.data.data.page, viewId: reply.data.data.viewId } : null);
      if (matches.length === 1) void invoke({ action: 'trace.show', traceId: matches[0]!.id });
      else setMessage(matches.length ? 'Multiple captured traces match this Activity request. Choose the original record.'
        : 'No captured evaluation trace for this Activity request in the current product data directory. Capture or source attribution may be unavailable.');
    }).catch(() => { if (current) setMessage('Captured trace lookup is unavailable. No model was run.'); });
    return () => { current = false; };
  }, [traceTarget, productRoot]);
  useEffect(() => {
    if (busy !== 'experiment.run' || !experimentId) return;
    const timer = setInterval(() => { void invoke({ action: 'experiment.show', experimentId }); }, 2000);
    return () => clearInterval(timer);
  }, [busy, experimentId]);
  async function validate() {
    if (!candidate) return;
    await invoke({ action: 'candidate.validate', candidateId: candidate.id, expectedRevision: candidate.revision, replay });
    await invoke({ action: 'candidate.show', candidateId: candidate.id });
  }
  async function startExperiment() {
    const value = parseObject(plan); setExperimentId(String(value.id ?? ''));
    await invoke({ action: 'experiment.run', plan: value });
  }
  const visibleTraces = traces.filter(item => (!entry || item.entry === entry) && (!status || item.status === status));
  const sourceRun = trace?.source.kind === 'product' && !!productRoot && trace.source.productRoot === productRoot
    && trace.source.runId && /^[1-9]\d*$/.test(trace.source.runId) ? Number(trace.source.runId) : null;
  const sourceSession = trace?.source.sessionId && /^[1-9]\d*$/.test(trace.source.sessionId) ? Number(trace.source.sessionId) : null;
  const platformRecord = platformSnapshot && 'record' in platformSnapshot.trace ? platformSnapshot.trace.record : null;
  const uploadEligible = trace && ('projection' in trace ? trace.uploadEligible : trace.source.kind === 'product' && !Array.isArray(trace.facts.langfuseObservations)
    && trace.complete && !trace.gaps.length && !!trace.endedAt);
  const resultPaging = result && (result.action === 'baseline.list' || result.action === 'benchmark.list' || result.action === 'experiment.list')
    && result.data.page && result.data.viewId ? { action: result.action, page: result.data.page, viewId: result.data.viewId } : null;
  const resultRecord = result?.action === 'baseline.create' && 'record' in result.data.baseline ? result.data.baseline.record
    : result?.action === 'gate.check' && 'record' in result.data.gate ? result.data.gate.record : null;
  return <section className="panel evaluation-loop" aria-label="Evaluation loop">
    <div className="panel-head"><h2>Evaluation loop</h2><button className="text-button" onClick={() => void invoke({ action: 'settings.get' })}>Refresh loop configuration</button></div>
    <p>Trace → Dataset → Evaluator → Experiment → Regression → Improvement</p>
    <p>Saved-record reads do not run models. Explicit mining and experiments make real model calls; upload sends captured materials.</p>
    {workspaceUnavailable && <p role="alert">{settings.workspace?.reason}</p>}
    <fieldset className="form-grid" disabled={writeDisabled}>
      {([['capture', 'Capture product traces'], ['upload', 'Upload captured traces'], ['mining', 'Automatically mine candidates']] as const).map(([key, label]) =>
        <label key={key}><input type="checkbox" checked={switches[key]} onChange={event => setSwitches({ ...switches, [key]: event.target.checked })} /> {label}</label>)}
      <button className="secondary-button" onClick={() => void invoke({ action: 'settings.save', settings: switches })}>Save trace switches</button>
    </fieldset>
    <details><summary>Configured roles and Langfuse · readiness is not quality</summary><pre className="evaluation-text">{json(settings ? { roles: settings.roles, langfuse: settings.langfuse } : 'not loaded')}</pre>
      <p>Native Judge and mining use the existing Codex login. Role credentials remain in private configuration.</p></details>
    {busy && <p role="status">{busy}: pending. Keep the original request; no automatic retry.</p>}
    {message && <p role="status">{message}</p>}
    {unknown && <div role="alert"><p>Original outcome is unknown. Read its saved record or receipt before another write.</p>
      <pre className="evaluation-text">{json(unknown)}</pre><button className="secondary-button" disabled={!!busy} onClick={() => void invoke(originalRead(unknown), true)}>Read original operation</button></div>}
    <nav aria-label="Evaluation loop sections">{(['traces', 'candidates', 'experiments'] as const).map(name =>
      <button key={name} className="text-button" aria-pressed={view === name} onClick={() => setView(name)}>{name[0]!.toUpperCase() + name.slice(1)}</button>)}</nav>

    {view === 'traces' && <section aria-label="Trace collection"><div className="panel-head"><h3>Captured traces</h3>
      <button className="text-button" onClick={() => { setTraceFilter(undefined); void invoke({ action: 'trace.list' }); }}>Refresh traces</button></div>
      {collectionPaging('trace.list', tracePage)}
      <div className="form-grid"><label className="field"><span>Trace UUID</span><input value={traceIdInput} onChange={event => setTraceIdInput(event.target.value)} /></label>
        <button className="text-button" disabled={!traceIdInput} onClick={() => void invoke({ action: 'trace.show', traceId: traceIdInput })}>Read Trace by ID</button></div>
      <p>Entry/status filters below apply to the displayed summary page. Open a known UUID directly or use the next page.</p>
      <div className="form-grid"><label className="field"><span>Trace entry filter</span><select value={entry} onChange={event => setEntry(event.target.value)}><option value="">All entries</option>
        {['chats', 'invoices', 'research', 'evaluation'].map(item => <option key={item}>{item}</option>)}</select></label>
        <label className="field"><span>Trace status filter</span><input value={status} placeholder="Exact actual status" onChange={event => setStatus(event.target.value)} /></label></div>
      {visibleTraces.length === 0 && <p>No captured traces match these filters.</p>}
      {visibleTraces.map(item => <p key={item.id}><button className="text-button" onClick={() => void invoke({ action: 'trace.show', traceId: item.id })}>{item.id}</button>
        {' '}v{item.revision} · {item.entry} · {item.status} · {item.complete ? 'capture complete' : 'capture incomplete'}</p>)}
      <details><summary>Read back remote observations</summary><div className="form-grid">
        <label className="field"><span>From (UTC ISO)</span><input value={from} onChange={event => setFrom(event.target.value)} /></label>
        <label className="field"><span>To (UTC ISO)</span><input value={to} onChange={event => setTo(event.target.value)} /></label>
        <label className="field full"><span>Remote Trace ID (optional)</span><input value={remoteId} onChange={event => setRemoteId(event.target.value)} /></label>
        <button className="secondary-button" disabled={writeDisabled} onClick={() => void invoke({ action: 'trace.pull', from, to, ...(remoteId ? { traceId: remoteId } : {}) })}>Read back Langfuse traces</button>
      </div></details>
      {trace && <section aria-label="Selected trace"><h4>{trace.id} · revision {trace.revision}</h4><p>{trace.status} · original capture {trace.complete ? 'complete' : 'incomplete'} · {'projection' in trace ? trace.gapCount : trace.gaps.length} gaps</p>
        {sourceRun !== null && Number.isSafeInteger(sourceRun) && onOpenActivity && <button className="text-button" onClick={() => onOpenActivity(sourceRun,
          sourceSession !== null && Number.isSafeInteger(sourceSession) ? sourceSession : null)}>Open source Activity</button>}
        {'projection' in trace ? <><p>Summary only. The input preview is not the complete original evidence.</p>
          <pre className="evaluation-text">{trace.inputPreview}</pre><p>{trace.eventCount} original observations · {trace.materialCount} materials · {trace.record.characters} original JSON characters.</p>
          <button className="secondary-button" disabled={recordBusy} onClick={() => void readRecord(trace.record)}>Read original Trace JSON</button></>
          : <details open><summary>Original inputs, outputs and materials</summary><pre className="evaluation-text">{json(trace)}</pre></details>}
        {platformSnapshot && <section aria-label="Saved platform snapshot"><h5>Saved Langfuse platform snapshot</h5><p>Read at {platformSnapshot.readAt}. Local original and platform readback are separate records.</p>
          <p>Platform capture: {platformSnapshot.trace.complete ? 'complete' : 'incomplete'} · {'projection' in platformSnapshot.trace ? platformSnapshot.trace.gapCount : platformSnapshot.trace.gaps.length} gaps</p>
          {platformRecord && <button className="secondary-button" disabled={recordBusy} onClick={() => void readRecord(platformRecord)}>Read saved platform snapshot JSON</button>}</section>}
        <p>Generic Trace upload accepts original local product captures only. Benchmark observations, Judge and scores use the saved Execution Export/resend service; platform-imported copies are never re-uploaded.</p>
        {'projection' in trace && <p role="status">{trace.uploadReason}</p>}
        {trace.source.kind === 'evaluation' && trace.source.executionId && onOpenExecution && <button className="secondary-button" onClick={() => onOpenExecution(trace.source.executionId!)}>Open saved Benchmark Execution</button>}
        <button className="secondary-button" disabled={writeDisabled || !uploadEligible} onClick={() => void invoke({ action: 'trace.upload', traceId: trace.id, expectedRevision: trace.revision, operationId: uuid() })}>Upload selected trace</button>
        <button className="text-button" disabled={writeDisabled || !reviewer.trim() || !note.trim()} onClick={() => void invoke({ action: 'trace.feedback', operationId: uuid(),
          target: { kind: 'trace-feedback', id: trace.id, revision: trace.revision }, reviewer, source: 'human', verdict: traceVerdict, note })}>Save trace feedback</button>
      </section>}
      <div className="form-grid"><label className="field"><span>Candidate kind</span><select value={kind} onChange={event => setKind(event.target.value as typeof kind)}>
        <option value="gold">gold</option><option value="bad">bad</option><option value="regression">regression</option></select></label>
        <button className="secondary-button" disabled={writeDisabled || !trace || !trace.complete} onClick={() => trace && void invoke({ action: 'mine', traceId: trace.id,
          expectedRevision: trace.revision, operationId: uuid(), kind })}>Mine selected trace</button></div>
      <p>Mining creates a draft. Independent Gold, validation and current human approval are still required.</p>
    </section>}

    {view === 'candidates' && <section aria-label="Candidate collection"><div className="panel-head"><h3>Candidate drafts</h3>
      <button className="text-button" onClick={() => void invoke({ action: 'candidate.list' })}>Refresh candidates</button></div>
      {collectionPaging('candidate.list', candidatePage)}
      <div className="form-grid"><label className="field"><span>Candidate UUID</span><input value={candidateIdInput} onChange={event => setCandidateIdInput(event.target.value)} /></label>
        <button className="text-button" disabled={!candidateIdInput} onClick={() => void invoke({ action: 'candidate.show', candidateId: candidateIdInput })}>Read candidate by ID</button></div>
      {candidates.length === 0 && <p>No candidate drafts.</p>}
      {candidates.map(item => <p key={item.id}><button className="text-button" onClick={() => void invoke({ action: 'candidate.show', candidateId: item.id })}>{item.id}</button>
        {' '}{item.kind} · revision {item.revision} · {item.status}</p>)}
      {candidate && <section aria-label="Selected candidate"><h4>{candidate.id} · revision {candidate.revision} · {candidate.status}</h4>
        <p>{candidate.reason}</p><details open><summary>Independent sources, expectations, controls and replay status</summary><pre className="evaluation-text">{json(candidate)}</pre></details>
        {'record' in candidate && <><p>Summary only. Case/Gold/scenario originals have not been loaded for editing.</p>
          <button className="secondary-button" disabled={editorLoading || recordBusy} onClick={() => void readRecord(candidate.record)}>Read original candidate JSON</button>
          <button className="secondary-button" disabled={writeDisabled || editorLoading || recordBusy} onClick={() => void loadCandidate()}>Load complete candidate for editing</button></>}
        {editorLoading && <p role="status">Reading all original candidate chunks; editing remains disabled.</p>}
        <fieldset disabled={writeDisabled || editorLoading || !fullCandidate || fullCandidate.id !== candidate.id || fullCandidate.revision !== candidate.revision}>
          <label className="field"><span>Candidate edit section</span><select aria-label="Candidate edit section" value={editSection} onChange={event => {
            const key = event.target.value; setEditSection(key); if (fullCandidate) setPatch(json({ [key]: Reflect.get(fullCandidate, key) }));
          }}>{fullCandidate && Object.keys(editable(fullCandidate)).map(key => <option key={key}>{key}</option>)}</select></label>
          <label className="field"><span>Candidate edit JSON</span><textarea aria-label="Candidate edit JSON" rows={14} value={patch} onChange={event => setPatch(event.target.value)} spellCheck={false} /></label>
          <button className="secondary-button" onClick={() => void withJSON(savePatch)}>Save candidate revision</button>
        </fieldset><fieldset disabled={writeDisabled}>
          <label><input type="checkbox" checked={replay} onChange={event => setReplay(event.target.checked)} /> Request controlled replay</label>
          <button className="secondary-button" onClick={() => void validate()}>Validate current candidate</button>
        </fieldset><p>Editing invalidates the old validation and approval. NOT_RUN is not a passed model replay.</p>
      </section>}
    </section>}

    {(view === 'traces' || view === 'candidates') && <fieldset className="form-grid" disabled={writeDisabled}>
      <legend>Human feedback</legend><label className="field"><span>Loop reviewer</span><input value={reviewer} onChange={event => setReviewer(event.target.value)} /></label>
      <label className="field full"><span>Loop feedback note</span><textarea value={note} onChange={event => setNote(event.target.value)} /></label>
      {view === 'traces' && <label className="field"><span>Trace feedback verdict</span><select aria-label="Trace feedback verdict" value={traceVerdict} onChange={event => setTraceVerdict(event.target.value as typeof traceVerdict)}>
        <option value="good">good</option><option value="bad">bad</option></select></label>}
      {view === 'candidates' && <><label className="field"><span>Candidate review verdict</span><select value={verdict} onChange={event => setVerdict(event.target.value as typeof verdict)}>
        <option value="needs-work">needs-work</option><option value="approve">approve</option><option value="reject">reject</option></select></label>
        <button className="secondary-button" disabled={!candidate || !reviewer.trim() || !note.trim()} onClick={() => candidate && void invoke({ action: 'candidate.review',
          operationId: uuid(), target: { kind: 'candidate-review', id: candidate.id, revision: candidate.revision }, reviewer, source: 'human', verdict, note })}>Save current candidate review</button>
        <label className="field"><span>Publish benchmark ID</span><input value={benchmark} onChange={event => setBenchmark(event.target.value)} /></label>
        <label className="field"><span>Current human approval ID</span><input value={approval} onChange={event => setApproval(event.target.value)} /></label>
        <label className="field full"><span>Published Smoke Case IDs (optional, comma separated)</span><input value={smokeIds} onChange={event => setSmokeIds(event.target.value)} /></label>
        <button className="secondary-button" disabled={!candidate || !benchmark || !approval} onClick={() => candidate && void invoke({ action: 'candidate.publish', operationId: uuid(),
          benchmarkId: benchmark, candidateIds: [candidate.id], approvals: [approval], smokeCaseIds: smokeIds.split(',').map(value => value.trim()).filter(Boolean) })}>Publish approved candidate snapshot</button></>}
    </fieldset>}

    {view === 'experiments' && <section aria-label="Experiment collection"><h3>Declared experiments and regression</h3>
      <button className="text-button" onClick={() => void invoke({ action: 'benchmark.list' })}>List published benchmarks</button>
      <label className="field"><span>Experiment plan JSON</span><textarea rows={16} value={plan} onChange={event => { setPlan(event.target.value); setPreviewedPlan(null); }} spellCheck={false} /></label>
      <p>Default plan: two models × Smoke7 × one repeat = 14 subject Trials. Full62 = 124; Smoke + Full = 138, plus explicitly selected published members. Cost is unknown.</p>
      <button className="secondary-button" disabled={disabled} onClick={() => void withJSON(() => ({ action: 'experiment.preview', plan: parseObject(plan) }))}>Preview declared experiment</button>
      <button className="primary-button" disabled={writeDisabled || previewedPlan !== plan} onClick={() => void startExperiment().catch(error => setMessage(error instanceof Error ? error.message : 'Invalid experiment plan.'))}>Run declared experiment</button>
      <button className="text-button" onClick={() => void invoke({ action: 'experiment.list' })}>Refresh experiments</button>
      {experiments.map(item => <p key={item.id}><button className="text-button" onClick={() => void invoke({ action: 'experiment.show', experimentId: item.id })}>{item.id}</button> · {item.status} · {item.attribution}</p>)}
      <div className="form-grid"><label className="field"><span>Experiment ID</span><input value={experimentId} onChange={event => setExperimentId(event.target.value)} /></label>
        <button className="text-button" disabled={!experimentId} onClick={() => void invoke({ action: 'experiment.show', experimentId })}>Read original experiment</button>
        <button className="secondary-button" disabled={writeDisabled || !experimentId} onClick={() => void invoke({ action: 'experiment.compare', experimentId })}>Compare declared arms</button>
        <label className="field"><span>Arm ID</span><input value={armId} onChange={event => setArmId(event.target.value)} /></label>
        <label className="field"><span>Explicit Baseline ID</span><input value={baselineId} onChange={event => setBaselineId(event.target.value)} /></label>
        <button className="secondary-button" disabled={writeDisabled || !experimentId || !armId || !baselineId} onClick={() => void invoke({ action: 'baseline.create', experimentId, armId, baselineId })}>Create explicit Baseline</button>
        <button className="text-button" onClick={() => void invoke({ action: 'baseline.list' })}>List Baselines</button>
        <label><input type="checkbox" checked={fullRelease} onChange={event => setFullRelease(event.target.checked)} /> Require Full release</label>
        <button className="secondary-button" disabled={writeDisabled || !experimentId || !armId || !baselineId} onClick={() => void invoke({ action: 'gate.check', baselineId, experimentId, armId, fullRelease })}>Check regression Gate</button>
      </div>{experiment && <details open><summary>Actual experiment state and saved execution identities</summary><pre className="evaluation-text">{json(experiment)}</pre></details>}
      <p>Smoke covers its selected Cases. Missing/error/incomparable evidence is blocked; controlled demonstrations do not establish a real-model release.</p>
    </section>}
    <section className="panel" aria-label="Original record reader"><h3>Complete original JSON · bounded read-only chunks</h3>
      <p>Original capture completeness and the current displayed chunk are different. Only a full, unchanged, unredacted candidate can enable editing.</p>
      <div className="form-grid"><label className="field"><span>Original record kind</span><select aria-label="Original record kind" value={recordKind} onChange={event => setRecordKind(event.target.value as RecordIdentity['kind'])}>
        {['trace', 'candidate', 'baseline', 'gate'].map(kind => <option key={kind}>{kind}</option>)}</select></label>
        <label className="field"><span>Original record ID</span><input value={recordId} onChange={event => setRecordId(event.target.value)} /></label>
        {recordKind === 'gate' && <label className="field"><span>Original Gate experiment ID</span><input value={recordExperimentId} onChange={event => setRecordExperimentId(event.target.value)} /></label>}
        <button className="text-button" disabled={recordBusy || !recordId} onClick={() => void readRecord({ kind: recordKind, id: recordId, part: 'record', ...(recordKind === 'gate' ? { experimentId: recordExperimentId } : {}) })}>Read known original record</button></div>
      {recordError && <p role="alert">{recordError}</p>}
      {recordChunk && <><p>{recordChunk.kind} {recordChunk.id} · {recordChunk.location}</p>
        <p>Characters {recordChunk.page.offset}–{Math.min(recordChunk.page.offset + recordChunk.page.limit, recordChunk.page.total)} / {recordChunk.page.total};
          {' '}end of record: {String(recordChunk.page.complete)}; redacted: {String(recordChunk.redacted)}. This view is one chunk, not a full-record acceptance.</p>
        <pre className="evaluation-text" aria-label="Original JSON chunk">{recordChunk.text}</pre>
        <button className="text-button" disabled={recordBusy || !recordChunk.page.offset} onClick={() => void readRecord(recordChunk, Math.max(0, recordChunk.page.offset - recordChunk.page.limit), recordChunk.viewId)}>Previous original chunk</button>
        <button className="text-button" disabled={recordBusy || recordChunk.page.nextOffset === null} onClick={() => recordChunk.page.nextOffset !== null && void readRecord(recordChunk, recordChunk.page.nextOffset, recordChunk.viewId)}>Next original chunk</button>
        <label className="field"><span>Original character offset</span><input type="number" min={0} value={recordOffset} onChange={event => setRecordOffset(event.target.value)} /></label>
        <button className="text-button" disabled={recordBusy} onClick={() => void readRecord(recordChunk, Number(recordOffset), recordChunk.viewId)}>Read original offset</button></>}
    </section>
    {resultRecord && <button className="text-button" onClick={() => void readRecord(resultRecord)}>Read complete {resultRecord.kind} JSON</button>}
    {result?.action === 'baseline.list' && result.data.items.map(item => 'record' in item && <button className="text-button" key={item.id} onClick={() => void readRecord(item.record)}>Read Baseline {item.id}</button>)}
    {resultPaging && <div><p>{resultPaging.page.total ? resultPaging.page.offset + 1 : 0}–{Math.min(resultPaging.page.offset + resultPaging.page.limit, resultPaging.page.total)} of {resultPaging.page.total} summaries</p>
      <button className="text-button" disabled={!resultPaging.page.offset} onClick={() => void invoke({ action: resultPaging.action,
        offset: Math.max(0, resultPaging.page.offset - resultPaging.page.limit), viewId: resultPaging.viewId })}>Previous saved summaries</button>
      <button className="text-button" disabled={resultPaging.page.nextOffset === null} onClick={() => resultPaging.page.nextOffset !== null && void invoke({ action: resultPaging.action,
        offset: resultPaging.page.nextOffset, viewId: resultPaging.viewId })}>Next saved summaries</button></div>}
    {result && <details open><summary>Actual workflow result · {result.action} · exit {result.exitCode}</summary><pre className="evaluation-text">{json(result.data)}</pre></details>}
  </section>;
}
