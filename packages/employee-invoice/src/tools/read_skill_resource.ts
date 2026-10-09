import { appError, ReadSkillResourceInputSchema, ReadSkillResourceOutputSchema } from '@flowmate/contracts';
import type { ReadSkillResourceInput, ReadSkillResourceOutput, ProductToolContext, Result, ToolDefinition } from '@flowmate/contracts';
import { unwrap } from './definition.ts';

export const readSkillResource = (read: (input: ReadSkillResourceInput, context: ProductToolContext) => Result<ReadSkillResourceOutput>) => ({
  name: 'read_skill_resource', version: '1', label: 'Read Skill resource',
  description: 'Read SKILL.md or a listed relative file from this Run\'s fixed Skill. Uses UTF-8 byte offset/limit; continue at nextOffset when present. Reading scripts never executes them.',
  inputSchema: ReadSkillResourceInputSchema, outputSchema: ReadSkillResourceOutputSchema,
  effect: 'READ', executionMode: 'parallel',
  execute: async (input, call, context) => {
    if (call.signal.aborted) throw appError('tool_cancelled', 'runtime', 'Skill reading was cancelled.', true,
      context.runId, context.sessionId, call.nativeToolCallId);
    return unwrap(read(input, context));
  },
} satisfies ToolDefinition<ReadSkillResourceInput, ReadSkillResourceOutput>);
