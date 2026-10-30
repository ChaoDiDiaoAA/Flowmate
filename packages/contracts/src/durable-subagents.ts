import type { DbId, Result } from './runtime.ts';
import type { PersonalAgentConfiguration } from './personal-agent.ts';
import type { DurableModelBinding, DurableProductToolCall, DurableSubmissionQuery, DurableSubmissionView } from './durable-runtime.ts';
import type { SUBAGENT_ROLE } from './subagents.ts';

/** Parent phase ownership stays intact; the child has its own product Run and Session. */
export type DurableSubagentIdentity = DurableSubmissionQuery & {
  childRunId: DbId; childSessionId: DbId; originToolCallId: DbId; nativeToolTaskId: number;
};
export type DurableSubagentPlan = DurableSubagentIdentity & {
  role: typeof SUBAGENT_ROLE; binding: DurableModelBinding;
  thinkingLevel: PersonalAgentConfiguration['thinkingLevel'];
  prompt: string; systemPrompt: string; allowedTools: readonly string[];
};
export type DurableSubagentObservation = DurableSubagentIdentity & {
  creation: 'created' | 'not-started' | 'unknown';
  nativeConversationId: number | null; nativeSubmissionId: number | null;
  status: DurableSubmissionView['status'] | null; answer: string | null; reason: string | null;
  consumedAt: string | null; execution: 'active' | 'closed' | 'unknown';
  creatorExecution: 'active' | 'closed' | 'unknown';
  parentToolResultEntryId: number | null; parentModelTaskId: number | null; parentModelReceivedAt: string | null;
};
/** Available only while the actual owning native ToolTask executes; never a model parameter. */
export type DurableSubagentInvoker = (plan: DurableSubagentPlan, signal: AbortSignal) => Promise<Result<DurableSubagentObservation>>;
export type DurableSubagentCallbacks = {
  readPlan(identity: DurableSubagentIdentity): Promise<Result<DurableSubagentPlan>>;
  verify(identity: DurableSubagentIdentity): Promise<Result<void>>;
  adopt(input: DurableSubagentIdentity & { nativeConversationId: number }): Promise<Result<void>>;
  reserveModelRequest(identity: DurableSubagentIdentity): Promise<Result<void>>;
  onParentConsumed(input: DurableSubagentIdentity & {
    nativeToolResultEntryId: number; nativeModelTaskId: number; observedAt: string;
  }): Promise<Result<void>>;
};
export type DurableChildToolOwner = Pick<DurableSubagentIdentity, 'childRunId' | 'childSessionId' | 'originToolCallId'>;
export type DurableWorkingContextQuery = DurableSubmissionQuery & { child?: DurableChildToolOwner };
export type DurableProductToolExecution = DurableProductToolCall & {
  signal: AbortSignal; nativeDelegate?: DurableSubagentInvoker;
};
