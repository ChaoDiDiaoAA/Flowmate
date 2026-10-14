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
        let schema: z.ZodTypeAny = definition.inputSchema;
        while (schema instanceof z.ZodEffects) schema = schema.innerType();
        const branches: z.ZodTypeAny[] = schema instanceof z.ZodUnion ? schema.options : [schema];
        const selected = branches.find(branch => {
          if (!(branch instanceof z.ZodObject) || raw === null || typeof raw !== 'object') return false;
          const literals = Object.entries(branch.shape).filter(([, value]) => value instanceof z.ZodLiteral);
          return literals.length > 0 && literals.every(([key, value]) => (value as z.ZodTypeAny).safeParse((raw as Record<string, unknown>)[key]).success);
        });
        const relevant = selected ? selected.safeParse(raw) : parsed;
        const errors = relevant.success ? parsed.error.issues : relevant.error.issues.flatMap(issue =>
          issue.code === 'invalid_union' ? issue.unionErrors.flatMap(error => error.issues) : [issue]);
        const issues = errors.slice(0, 6).map(issue => ({ code: issue.code,
          path: issue.path.slice(0, 8).map(part => String(part).slice(0, 64)).join('.'),
          ...(issue.code==='custom'?{constraint:issue.message.replace(/\s+/g,' ').slice(0,180)}:{}),
          ...(issue.code==='invalid_type'?{expected:issue.expected}:{}),
          ...(issue.code==='invalid_string'?{validation:issue.validation}:{}),
          ...('minimum' in issue ? { minimum: issue.minimum } : {}),
          ...('maximum' in issue ? { maximum: issue.maximum } : {}),
          ...(issue.code==='invalid_enum_value'?{allowed:issue.options}:{}),
          ...('keys' in issue ? { unexpectedKeyCount: issue.keys.length } : {}) }));
        const descriptions = (selected ? [selected] : branches).slice(0, 6).map(branch => {
          const shape = (branches.length === 1 && !selected ? parameters : toPiParameters(branch)) as TSchema & { properties?: Record<string, TSchema>; required?: string[] };
          const properties = shape.properties;
          return { allowedKeys: Object.keys(properties ?? {}).slice(0, 24), required: shape.required,
            constraints: Object.fromEntries(Object.entries(properties ?? {}).slice(0, 24).map(([key, value]) => [key, value])) };
        });
        throw new Error(`Invalid arguments for ${definition.name}; first validation errors: ${JSON.stringify(issues)}. Branch constraints: ${JSON.stringify(descriptions)}. Correct these fields within the remaining budget.`.slice(0,4000));
      }
      return parsed.data as never;
    },
    execute(toolCallId, input, signal) {
      return execute(toolCallId, input, signal);
    },
  };
}
