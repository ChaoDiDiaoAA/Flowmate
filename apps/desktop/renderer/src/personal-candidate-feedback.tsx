import { useState } from 'react';
import type { InvoiceWorkFeedback, InvoiceWorkFeedbackApi } from '@flowmate/contracts';

type Target = Parameters<InvoiceWorkFeedbackApi['get']>[0];
export type AssociatedExecution = Extract<InvoiceWorkFeedback['association'], { status: 'associated' }>;

export function PersonalCandidateFeedback({ target, onOpen }: { target: Target; onOpen(execution: AssociatedExecution): void }) {
  const [saved, setSaved] = useState<InvoiceWorkFeedback | null>(), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const association = saved?.association;
  async function read() {
    setBusy(true); setError(null);
    try {
      const result = await window.flowmate.invoiceWorkFeedback.get(target);
      if (result.ok) setSaved(result.data); else setError(result.error.message);
    } catch { setError('Candidate feedback could not be read.'); }
    finally { setBusy(false); }
  }
  async function submit(helpful: boolean) {
    setBusy(true); setError(null);
    try {
      const result = await window.flowmate.invoiceWorkFeedback.submit({ ...target, helpful });
      if (result.ok) setSaved(result.data); else setError(result.error.message);
    } catch { setError('Candidate feedback could not be confirmed. Reopen to check the saved vote.'); }
    finally { setBusy(false); }
  }
  return <details onToggle={event => { if (event.currentTarget.open && !busy) void read(); }}>
    <summary>Candidate feedback</summary>
    {error && <p role="alert">{error}</p>}
    {saved === null && <div className="button-row">
      <button type="button" disabled={busy} onClick={() => void submit(true)}>Helpful</button>
      <button type="button" disabled={busy} onClick={() => void submit(false)}>Not helpful</button>
    </div>}
    {saved && <p>Feedback saved · {saved.helpful ? 'Helpful' : 'Not helpful'}{saved.association.status === 'unavailable' && ' · Original execution unavailable'}</p>}
    {association?.status === 'associated' && <button type="button" onClick={() => onOpen(association)}>View original execution</button>}
  </details>;
}
