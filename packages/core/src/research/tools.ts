import { ResearchPlanToolInputSchema, ResearchPlanSchema, ToolExecutionFailure, appError } from '@flowmate/contracts';
import type { ResearchPlanBody, ResearchPlan, ToolDefinition } from '@flowmate/contracts';
import type { ResearchRepository } from './repository.ts';
import type { ToolCallRepository } from '../storage/repositories.ts';

export function createResearchPlanTool(research: ResearchRepository, calls: ToolCallRepository, now: () => string): ToolDefinition<ResearchPlanBody, ResearchPlan> {
  return { name: 'save_research_plan', version: 'p15-v1', label: 'Save research plan', effect: 'LOCAL_WRITE', executionMode: 'sequential',
    description: 'Save a versioned research plan for user confirmation. Include dimensions, questions, evidence needs, authorized sources, explicit execution budget and stop conditions. Does not begin investigation. Finish this planning Run after receiving the saved receipt.',
    inputSchema: ResearchPlanToolInputSchema, outputSchema: ResearchPlanSchema,
    execute: async (body, call, context) => {
      const binding = research.bindingForRun(context.runId);
      if (!binding.ok) throw new ToolExecutionFailure(binding.error);
      if (!binding.data) throw new ToolExecutionFailure(appError('research_identity_conflict', 'runtime', 'This Run is not a research task.'));
      const savedCall = calls.get({ runId: context.runId, sessionId: context.sessionId, nativeToolCallId: call.nativeToolCallId });
      if (!savedCall.ok) throw new ToolExecutionFailure(savedCall.error);
      if (call.signal.aborted) throw new ToolExecutionFailure(appError('agent_cancelled', 'runtime', 'Research planning was cancelled.'));
      const saved = research.savePlan({ researchId: binding.data.researchId, runId: context.runId, toolCallId: savedCall.data.toolCallId, body, at: now() });
      if (!saved.ok) throw new ToolExecutionFailure(saved.error);
      return saved.data;
    } };
}
