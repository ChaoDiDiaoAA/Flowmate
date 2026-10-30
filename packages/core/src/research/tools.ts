import { ResearchPlanToolInputSchema, ResearchPlanSchema, ToolExecutionFailure, appError } from '@flowmate/contracts';
import type { ResearchPlanBody, ResearchPlan, ToolCallContext, ToolDefinition } from '@flowmate/contracts';
import type { DbHandle } from '../storage/database.ts';

export function checkResearchControl(call: ToolCallContext): void {
  if (call.signal.aborted) throw new ToolExecutionFailure(appError('agent_cancelled', 'runtime', 'Research operation was cancelled.'));
  if (call.deadlineAt !== undefined && performance.now() >= call.deadlineAt)
    throw new ToolExecutionFailure(appError('tool_timeout', 'tool', 'The Research operation deadline elapsed.', true));
}

export function createResearchPlanTool(database: Pick<DbHandle, 'read' | 'transaction'>, now: () => string): ToolDefinition<ResearchPlanBody, ResearchPlan> {
  return { name: 'save_research_plan', version: 'p15-v1', label: 'Save research plan', effect: 'LOCAL_WRITE', executionMode: 'sequential',
    description: 'Save a versioned research plan for user confirmation. Include dimensions, questions, evidence needs, authorized sources, explicit execution budget and stop conditions. Does not begin investigation. Finish this planning Run after receiving the saved receipt.',
    inputSchema: ResearchPlanToolInputSchema, outputSchema: ResearchPlanSchema,
    execute: async (body, call, context) => {
      body = structuredClone(body); call = { ...call }; context = structuredClone(context);
      let confirmed: ResearchPlan | undefined;
      return database.transaction(store => {
        checkResearchControl(call);
        const binding = store.research.bindingForRun(context.runId);
        if (!binding.ok) throw new ToolExecutionFailure(binding.error);
        if (!binding.data) throw new ToolExecutionFailure(appError('research_identity_conflict', 'runtime', 'This Run is not a research task.'));
        const savedCall = store.toolCalls.get({ runId: context.runId, sessionId: context.sessionId, nativeToolCallId: call.nativeToolCallId });
        if (!savedCall.ok) throw new ToolExecutionFailure(savedCall.error);
        const saved = store.research.savePlan({ researchId: binding.data.researchId, runId: context.runId, toolCallId: savedCall.data.toolCallId, body, at: now() });
        if (!saved.ok) throw new ToolExecutionFailure(saved.error);
        store.db.afterCommit?.(() => { confirmed = saved.data; });
        return saved.data;
      }).catch(error => { if (confirmed !== undefined) return confirmed;
        throw error instanceof ToolExecutionFailure ? error
        : new ToolExecutionFailure(appError('research_write_failed', 'storage', 'Research storage is unavailable.', true)); });
    } };
}
