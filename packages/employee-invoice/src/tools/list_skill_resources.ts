import { appError, ListSkillResourcesInputSchema, ListSkillResourcesOutputSchema } from '@flowmate/contracts';
import type { ListSkillResourcesInput, ListSkillResourcesOutput, ProductToolContext, Result, ToolDefinition } from '@flowmate/contracts';
import { unwrap } from './definition.ts';

export const listSkillResources = (list: (input: ListSkillResourcesInput, context: ProductToolContext) => Result<ListSkillResourcesOutput> | Promise<Result<ListSkillResourcesOutput>>) => ({
  name: 'list_skill_resources', version: '1', label: 'List Skill resources',
  description: 'List the registered files of an available Skill in this Run. Returns file metadata only; does not read or execute content.',
  inputSchema: ListSkillResourcesInputSchema, outputSchema: ListSkillResourcesOutputSchema,
  effect: 'READ', executionMode: 'parallel',
  execute: async (input, call, context) => {
    if (call.signal.aborted) throw appError('tool_cancelled', 'runtime', 'Skill listing was cancelled.', true,
      context.runId, context.sessionId, call.nativeToolCallId);
    return unwrap(await list(input, context));
  },
} satisfies ToolDefinition<ListSkillResourcesInput, ListSkillResourcesOutput>);
