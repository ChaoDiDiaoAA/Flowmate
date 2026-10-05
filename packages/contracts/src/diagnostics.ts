export type PromptTraceEvent =
  | 'model_request'
  | 'request_budget'
  | 'request_dispatched'
  | 'response_started'
  | 'text_delta'
  | 'native_terminal'
  | `agent:${import('./ports.ts').AgentNativeEventName}`;

export type PromptTraceReference = {
  purpose?: 'answer' | 'summary-history' | 'summary-turn-prefix';
  answerRequestSequence?: number | null;
  operationId?: string;
  runId: number;
  sessionId: number;
  nativeSessionId: string;
  callSequence: number;
};

export type PromptTraceEntry = {
  at: string;
  event: PromptTraceEvent;
  summary: string;
  truncated: boolean;
};

export type PromptTraceCall = PromptTraceReference & {
  state: 'active' | 'ended';
  entries: PromptTraceEntry[];
  droppedEntries: number;
};

export type PromptTraceAvailability =
  | 'available'
  | 'not-started'
  | 'evicted'
  | 'process-exited'
  | 'source-unavailable'
  | 'not-collected';

export type PromptTraceResult = {
  availability: PromptTraceAvailability;
  calls: PromptTraceCall[];
  droppedCalls: number | null;
};

export interface PromptTraceBuffer {
  begin(reference: PromptTraceReference): void;
  append(reference: PromptTraceReference, entry: PromptTraceEntry): void;
  end(reference: PromptTraceReference): void;
  clearSession(sessionId: number): void;
  query(runId: number, callSequence?: number): PromptTraceResult;
}
