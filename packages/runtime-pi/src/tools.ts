import type { TSchema } from '@earendil-works/pi-ai';
import type { AgentToolResult, ToolDefinition as PiToolDefinition } from '@earendil-works/pi-coding-agent';
import type { ToolDefinition } from '@flowmate/contracts';
import { z } from 'zod';
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
          ...(issue.code==='custom'?{constraint:issue.message.replace(/\s+/g,' ').slice(0,180)}:{}),
          ...(issue.code==='invalid_type'?{expected:issue.expected}:{}),
          ...('keys' in issue ? { unexpectedKeys: issue.keys.slice(0, 6).map(key => key.slice(0, 64)) } : {}) }));
        const allowedKeys = definition.inputSchema instanceof z.ZodObject ? Object.keys(definition.inputSchema.shape).slice(0,24) : undefined;
        throw new Error(`Invalid arguments for ${definition.name}; first validation errors: ${JSON.stringify(issues)}. ${JSON.stringify({allowedKeys})}. Correct these fields and reuse exact read receipts.`.slice(0,4000));
      }
      return parsed.data as never;
    },
    execute(toolCallId, input, signal) {
      return execute(toolCallId, input, signal);
    },
  };
}
