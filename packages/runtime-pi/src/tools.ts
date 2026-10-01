import type { TSchema } from '@earendil-works/pi-ai';
import type { AgentToolResult, ToolDefinition as PiToolDefinition } from '@earendil-works/pi-coding-agent';
import type { ToolDefinition } from '@flowmate/contracts';
import { toPiParameters } from './schema.ts';
import { getNativeToolParameters } from './native-tools.ts';

export function toPiTool(
  definition: ToolDefinition<any, any>,
  execute: (toolCallId: string, input: unknown, signal?: AbortSignal) => Promise<AgentToolResult<unknown>>,
): PiToolDefinition {
  const parameters = getNativeToolParameters(definition) ?? toPiParameters(definition.inputSchema) as TSchema;
  return {
    name: definition.name,
    label: definition.label ?? definition.name,
    description: definition.description,
    parameters,
    executionMode: definition.executionMode,
    prepareArguments(raw) {
      const parsed = definition.inputSchema.safeParse(raw);
      if (!parsed.success) throw new Error('工具参数不符合输入 Schema。');
      return parsed.data as never;
    },
    execute(toolCallId, input, signal) {
      return execute(toolCallId, input, signal);
    },
  };
}
