import type { EvaluationControlState, EvaluationEvent } from '../../../../packages/contracts/src/evaluation.ts';

export type EvaluationViewState = { revision: number; sequence: number; control: EvaluationControlState | null };
export const createEvaluationView = (): EvaluationViewState => ({ revision: 0, sequence: 0, control: null });
export function applyEvaluationControl(current: EvaluationViewState, control: EvaluationControlState, revision: number): EvaluationViewState {
  if (revision !== current.revision) return current;
  const changed = current.control !== null && current.control.sessionId !== control.sessionId;
  if (changed && (evaluationBusy(current.control) || current.control?.stop === 'pending' || current.control?.stop === 'unconfirmed')) return current;
  return { revision: current.revision + 1, sequence: changed ? 0 : current.sequence, control };
}
export function applyEvaluationEvent(current: EvaluationViewState, event: EvaluationEvent): EvaluationViewState {
  if (current.control && current.control.sessionId !== event.sessionId || event.sequence <= current.sequence) return current;
  return { revision: current.revision + 1, sequence: event.sequence, control: event.control };
}
export const evaluationBusy = (control: EvaluationControlState | null) => control !== null
  && ['preparing', 'running', 'cancelling', 'stop-unconfirmed', 'interrupted'].includes(control.state);
