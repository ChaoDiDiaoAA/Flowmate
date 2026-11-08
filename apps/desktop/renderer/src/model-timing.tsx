import { useEffect, useState } from 'react';
import type { PromptTraceResult, PromptTraceTiming } from '@flowmate/contracts';

const duration = (ms: number | null) => ms === null ? 'unavailable' : `${ms.toFixed(1)} ms`;
const outcome = { done: 'settled', error: 'failed', aborted: 'cancelled', incomplete: 'settlement unconfirmed', pending: 'in progress' } as const;

export function ModelTiming({ timing }: { timing: PromptTraceTiming }) {
  const beforeHttp = { entered: duration(timing.beforeHttpMs), 'not-entered': 'HTTP not entered', unobservable: 'transport not observable' };
  return <ul>
    <li>Model stream: {outcome[timing.outcome]} · {duration(timing.elapsedMs)}</li>
    <li>Before HTTP: {beforeHttp[timing.transport]}</li>
    {timing.budgetMs !== null && <li>Budget reservation: {duration(timing.budgetMs)}</li>}
    {timing.attempts.map((attempt, index) => <li key={index}>HTTP {index + 1}: {
      attempt.status === null ? { headers: 'headers received', pending: 'headers unconfirmed', error: 'transport failed', aborted: 'cancelled' }[attempt.outcome]
        : `${attempt.status}${attempt.status >= 400 ? ' (error)' : ''} · headers in ${duration(attempt.headersMs)}`
    }</li>)}
    {timing.droppedAttempts > 0 && <li>{timing.droppedAttempts} additional HTTP attempts omitted</li>}
    <li>First visible text: {duration(timing.firstTextMs)}</li>
  </ul>;
}

export function PersonalModelDiagnostics({ runId, origin }: { runId: number;
  origin?: { generationTaskId: number; observationId?: string; callSequence?: number } }) {
  const [open, setOpen] = useState(false), [refresh, setRefresh] = useState(0);
  const [trace, setTrace] = useState<PromptTraceResult | null>(null), [error, setError] = useState(false);
  const [phase, setPhase] = useState('');
  const phases = [...new Set(trace?.calls.flatMap(call => call.durable ? [call.durable.phaseId] : []))];
  const original = origin?.observationId ? trace?.calls.find(call =>
    call.observationId === origin.observationId && call.durable?.nativeTaskId === origin.generationTaskId) : undefined;
  useEffect(() => {
    if (!open) return;
    let current = true;
    setError(false);
    void window.flowmate.queryPromptTrace(runId, origin?.callSequence).then(result => {
      if (!current) return;
      if (result.ok) setTrace(result.data); else setError(true);
    }, () => { if (current) setError(true); });
    return () => { current = false; };
  }, [runId, open, refresh, origin?.callSequence]);
  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Model request diagnostics</summary>
    <button type="button" onClick={() => setRefresh(value => value + 1)}>Refresh diagnostics</button>
    {error && <p role="alert">Model request diagnostics are unavailable.</p>}
    {origin && trace && <p>{original ? `Original model observation · Task ${origin.generationTaskId} · Request ${original.callSequence}`
      : `Original GenerationTask ${origin.generationTaskId} · model observation unavailable`}</p>}
    {original?.timing && <ModelTiming timing={original.timing} />}
    {trace && <><p>{trace.availability === 'process-exited' ? 'Observation not collected or expired'
      : trace.availability.replaceAll('-', ' ')} · {trace.droppedCalls ?? 'Unknown'} evicted requests</p>
      {phases.length > 1 && <label>Phase <select value={phase} onChange={event => setPhase(event.target.value)}>
        <option value="">All phases</option>
        {phases.map(id => <option key={id} value={id}>{id}</option>)}
      </select></label>}
      {trace.calls.filter(call => call !== original && (!phase || String(call.durable?.phaseId) === phase)).map(call => <div key={call.observationId ?? call.callSequence}>
        <strong>Request {call.callSequence}{call.durable && ` · Item ${call.durable.itemId} · Phase ${call.durable.phaseId} · Task ${call.durable.nativeTaskId}`}</strong>
        {call.startedAt && <p>Observed {call.startedAt}{call.endedAt ? ` → ${call.endedAt}` : ''}</p>}
        {call.timing && <ModelTiming timing={call.timing} />}
      </div>)}</>}
  </details>;
}
