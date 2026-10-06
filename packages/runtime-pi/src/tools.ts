import type { TSchema } from '@earendil-works/pi-ai';
import type { AgentToolResult, ToolDefinition as PiToolDefinition } from '@earendil-works/pi-coding-agent';
import type { ToolDefinition } from '@flowmate/contracts';
import { toPiParameters } from './schema.ts';
import { getNativeToolParameters } from './native-tools.ts';

export function toPiTool(
  definition: ToolDefinition<any, any>,
  execute: (toolCallId: string, input: unknown, signal?: AbortSignal) => Promise<AgentToolResult<unknown>>,
  invalidArguments?: (raw: unknown) => void,
  nativeParameters?: TSchema,
): PiToolDefinition {
  const parameters = nativeParameters ?? getNativeToolParameters(definition) ?? toPiParameters(definition.inputSchema) as TSchema;
  return {
    name: definition.name,
    label: definition.label ?? definition.name,
    description: definition.description,
    parameters,
    executionMode: definition.executionMode,
    prepareArguments(raw) {
      const parsed = definition.inputSchema.safeParse(raw);
      if (!parsed.success) {
        invalidArguments?.(raw);
        const issues = parsed.error.issues.slice(0, 6).map(issue => ({ code: issue.code,
          path: issue.path.slice(0, 8).map(part => String(part).slice(0, 64)).join('.'),
          ...('keys' in issue ? { unexpectedKeys: issue.keys.slice(0, 6).map(key => key.slice(0, 64)) } : {}) }));
        throw new Error(`Invalid arguments for ${definition.name}; first validation errors: ${JSON.stringify(issues)}. Correct these fields and use only schema keys.`);
      }
      return parsed.data as never;
    },
    execute(toolCallId, input, signal) {
      return execute(toolCallId, input, signal);
    },
  };
}
