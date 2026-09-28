import { z } from 'zod';
import type { AppError, DbId } from './runtime.ts';

export const ToolEffectSchema = z.enum(['PURE', 'READ', 'LOCAL_WRITE']);
export type ToolEffect = z.infer<typeof ToolEffectSchema>;

const toolIdentitySchema = z.object({
  name: z.string().min(1).max(128),
  version: z.string().min(1).max(32),
  effect: ToolEffectSchema,
}).strict();

export const RunScopeSchema = z.object({
  version: z.literal(2),
  allowedTools: z.array(z.string().min(1).max(128)).max(64),
  allowedDocumentIds: z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).max(64),
  allowedArtifactIds: z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).max(128),
  allowedResourcePaths: z.array(z.string().min(1).max(4096)).max(64),
}).strict();

export type RunScope = z.infer<typeof RunScopeSchema>;
export type ToolIdentity = z.infer<typeof toolIdentitySchema>;

export const ToolExecutionContextSchema = z.object({
  runId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sessionId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  nativeToolCallId: z.string().min(1).max(256),
  scope: RunScopeSchema,
  signal: z.custom<AbortSignal>((value) => typeof value === 'object' && value !== null
    && typeof (value as AbortSignal).aborted === 'boolean'
    && typeof (value as AbortSignal).addEventListener === 'function'),
}).strict();

export type ToolExecutionContext = z.infer<typeof ToolExecutionContextSchema>;

export type ToolResult<O> =
  | { status: 'succeeded'; data: O }
  | { status: 'failed' | 'cancelled'; error: AppError; data?: O };

export type ExecuteOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type Tool<I, O> = {
  name: string;
  version: string;
  description: string;
  inputSchema: z.ZodType<I>;
  outputSchema?: z.ZodType<O>;
  effect: ToolEffect;
};

export type AgentTool<I, O> = Tool<I, O> & {
  execute(input: I, context: ToolExecutionContext): Promise<O>;
};

export type ToolDefinition<I, O> = AgentTool<I, O> & { label?: string };

export { toolIdentitySchema };
export type { DbId };
