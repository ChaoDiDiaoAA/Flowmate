import { useEffect, useRef, useState } from 'react';
import type { DesktopEvent, ModelProfile, ProviderOutcome } from '@flowmate/contracts';

const goal = 'Optimize the supplied prompt. Preserve its language, task, factual meaning, and constraints. Apply the optional requirements without inventing facts. Return only the improved prompt, without commentary or code fences.';
type Finished = Extract<DesktopEvent, { type: 'provider_finished' }>;
type Operation = { requestId: string | null; runId: number | null };

export function PromptOptimizer({ visible, hostEpoch, ready, model, onUse }: {
  visible: boolean; hostEpoch: number; ready: boolean; model: ModelProfile | null; onUse(text: string): void;
}) {
  const [original, setOriginal] = useState(''), [requirements, setRequirements] = useState('');
  const [optimized, setOptimized] = useState(''), [feedback, setFeedback] = useState('');
  const [operation, setOperation] = useState<Operation | null>(null), [stopping, setStopping] = useState(false);
  const current = useRef<Operation | null>(null), early = useRef(new Map<string, Finished>());
  const text = `Original prompt:\n${original}\n\nOptimization requirements:\n${requirements}`;
  const tooLarge = new TextEncoder().encode(`${goal}\n\n${text}`).byteLength > 65_536;

  function finish(owner: Operation, result: Finished['result']) {
    if (current.current !== owner) return;
    if (result.ok && !result.data.stopped) { setFeedback('The request has ended, but its stop is not confirmed. Check status.'); return; }
    if (result.ok && result.data.status === 'completed') { setOptimized(result.data.text); setFeedback('Prompt optimized. You can edit it before using it.'); }
    else setFeedback(result.ok ? result.data.error?.message ?? 'Optimization stopped. Your drafts are preserved.' : result.error.message);
    current.current = null; setOperation(null); setStopping(false); early.current.clear();
  }
  async function check(owner: Operation) {
    if (!owner.runId || current.current !== owner) return;
    try {
      const result = await window.flowmate.queryRun(owner.runId);
      if (current.current !== owner) return;
      if (!result.ok) { setFeedback('The saved result could not be checked. Your drafts are preserved.'); return; }
      const run = result.data;
      if (run.runId !== owner.runId || run.kind !== 'provider') return;
      if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
        const outcome: ProviderOutcome = { runId: run.runId, status: run.status, text: typeof run.output?.text === 'string' ? run.output.text : '',
          error: run.error, stopped: run.stoppedAt !== null, cleanupErrors: [] };
        finish(owner, { ok: true, data: outcome });
      }
    } catch { if (current.current === owner) setFeedback('The saved result could not be checked. Your drafts are preserved.'); }
  }
  useEffect(() => {
    if (current.current) setFeedback('The Host changed. Your drafts are preserved; check the runtime before starting again.');
    current.current = null; setOperation(null); setStopping(false); early.current.clear();
    return window.flowmate.subscribe(event => {
      if (event.type !== 'provider_finished') return;
      const owner = current.current;
      if (!owner) return;
      if (owner.requestId === event.requestId && owner.runId === event.runId) finish(owner, event.result);
      else if (owner.requestId === null) {
        early.current.set(event.requestId, event);
        if (early.current.size > 4) early.current.delete(early.current.keys().next().value!);
      }
    });
  }, [hostEpoch]);
  useEffect(() => {
    if (!operation?.runId) return;
    void check(operation);
    const timer = window.setInterval(() => { void check(operation); }, 2000);
    return () => window.clearInterval(timer);
  }, [operation]);
  async function optimize() {
    if (!ready || !model || !original.trim() || tooLarge || current.current) return;
    const owner: Operation = { requestId: null, runId: null };
    current.current = owner; setOperation(owner); setFeedback('Optimizing your prompt…');
    try {
      const runtime = await window.flowmate.queryRuntimeState();
      if (current.current !== owner) return;
      if (!runtime.ok || runtime.data.blocked || runtime.data.active !== null) {
        current.current = null; setOperation(null); setFeedback('The runtime is unavailable or busy. Your drafts are preserved.'); return;
      }
      const accepted = await window.flowmate.callProvider({ goal, text, modelId: model.id });
      if (current.current !== owner) return;
      if (!accepted.ok) {
        current.current = null; setOperation(null); setFeedback(accepted.error.message); return;
      }
      owner.requestId = accepted.data.requestId; owner.runId = accepted.data.runId;
      const active = { ...owner }; current.current = active; setOperation(active);
      const finished = early.current.get(active.requestId!); early.current.clear();
      if (finished?.runId === active.runId) finish(active, finished.result);
    } catch {
      if (current.current === owner) { current.current = null; setOperation(null); setFeedback('Optimization could not be submitted. Your drafts are preserved.'); }
    }
  }
  async function stop() {
    const owner = current.current;
    if (!owner?.requestId || stopping) return;
    setStopping(true);
    try {
      const result = await window.flowmate.cancelProvider(owner.requestId);
      if (current.current !== owner) return;
      if (!result.ok) { setStopping(false); setFeedback(result.error.message); }
      else { setFeedback('Stopping optimization…'); await check(owner); }
    } catch { if (current.current === owner) { setStopping(false); setFeedback('Stop could not be confirmed. Check status before trying again.'); } }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(optimized); setFeedback('Copied optimized prompt.'); }
    catch { setFeedback('Copy failed. You can select and copy the optimized prompt.'); }
  }
  return <section hidden={!visible} className="page-content prompt-workbench">
    <div className="page-heading"><div><span className="section-index">PROMPT WORKBENCH</span><h1>Prompts</h1><p>Make your instructions clearer while keeping your intent.</p></div></div>
    <p className="optimizer-model">{model ? `Using ${model.name}` : 'Choose a model in Models to optimize prompts.'} · Optimization uses your model and may incur usage charges.</p>
    <div className="prompt-editors"><section className="panel prompt-editor"><label className="field"><span>Original prompt</span>
      <textarea aria-label="Original prompt" value={original} disabled={operation !== null} onChange={event => setOriginal(event.target.value)} placeholder="Paste the prompt you want to improve…" rows={10} /></label>
      <label className="field"><span>Optimization requirements <small>Optional</small></span><textarea aria-label="Optimization requirements" value={requirements}
        disabled={operation !== null} onChange={event => setRequirements(event.target.value)} placeholder="For example: clarify the output format" rows={3} /></label>
      {tooLarge && <p role="alert">The prompt and requirements exceed the 64 KiB input limit.</p>}
      <div className="config-actions">{operation ? <><button className="secondary-button" disabled={!operation.requestId || stopping} onClick={() => void stop()}>{stopping ? 'Stopping…' : 'Stop'}</button>
        <button className="text-button" disabled={!operation.runId} onClick={() => void check(current.current!)}>Check status</button></>
        : <button className="primary-button" disabled={!ready || !model || !original.trim() || tooLarge} onClick={() => void optimize()}>Optimize</button>}</div></section>
      <section className="panel prompt-editor"><label className="field"><span>Optimized prompt</span><textarea aria-label="Optimized prompt" value={optimized}
        disabled={operation !== null} onChange={event => setOptimized(event.target.value)} placeholder="Your improved prompt will appear here…" rows={16} /></label>
        <div className="config-actions"><button className="secondary-button" disabled={!optimized.trim() || operation !== null} onClick={() => void copy()}>Copy</button>
          <button className="primary-button" disabled={!optimized.trim() || operation !== null} onClick={() => { onUse(optimized); setFeedback('Added to your chat draft.'); }}>Use in chat</button></div></section></div>
    {feedback && <p role="status" className="optimizer-feedback">{feedback}</p>}
  </section>;
}
