export type ModelTraceObservation = ({ runId: number; operationId?: string } | { runId: null; operationId: string }) & {
  sessionId: number; callSequence: number; phase: 'request' | 'response';
  at: string; model: string; api: string; data: unknown;
  purpose?: 'agent' | 'summary-history' | 'summary-turn-prefix';
};
