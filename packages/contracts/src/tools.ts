import { z } from 'zod';
import type { AppError, DbId } from './runtime.ts';

export const ToolEffectSchema = z.enum(['PURE', 'READ', 'LOCAL_WRITE']);
export type ToolEffect = z.infer<typeof ToolEffectSchema>;

export const ToolExecutionModeSchema = z.enum(['sequential', 'parallel']);
export type ToolExecutionMode = z.infer<typeof ToolExecutionModeSchema>;

export const ToolIdentitySchema = z.object({
  name: z.string().min(1).max(128),
  version: z.string().min(1).max(32),
  effect: ToolEffectSchema,
  executionMode: ToolExecutionModeSchema,
}).strict();

export const RunScopeSchema = z.object({
  version: z.literal(2),
  allowedTools: z.array(z.string().min(1).max(128)).max(64),
  allowedDocumentIds: z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).max(64),
  allowedArtifactIds: z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).max(128),
  allowedResourcePaths: z.array(z.string().min(1).max(4096)).max(64),
}).strict();

type RunScopeValues = z.infer<typeof RunScopeSchema>;
export type RunScope = Readonly<Omit<RunScopeValues,
  'allowedTools' | 'allowedDocumentIds' | 'allowedArtifactIds' | 'allowedResourcePaths'>> & {
  readonly allowedTools: readonly string[];
  readonly allowedDocumentIds: readonly number[];
  readonly allowedArtifactIds: readonly number[];
  readonly allowedResourcePaths: readonly string[];
};
export type ToolIdentity = z.infer<typeof ToolIdentitySchema>;

export const ToolExecutionContextSchema = z.object({
  runId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sessionId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  nativeToolCallId: z.string().min(1).max(256),
  scope: RunScopeSchema,
  signal: z.custom<AbortSignal>((value) => typeof value === 'object' && value !== null
    && typeof (value as AbortSignal).aborted === 'boolean'
    && typeof (value as AbortSignal).addEventListener === 'function'),
}).strict();

export type ToolExecutionContext = Readonly<Omit<z.infer<typeof ToolExecutionContextSchema>, 'scope'> & { scope: RunScope }>;
export type ToolCallContext = Pick<ToolExecutionContext, 'nativeToolCallId' | 'signal'>;
export type ProductToolContext = Pick<ToolExecutionContext, 'sessionId' | 'runId' | 'scope'>;

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
  label?: string;
  executionMode: ToolExecutionMode;
  execute(input: I, call: ToolCallContext): Promise<O>;
};

export type ToolDefinition<I, O> = Omit<AgentTool<I, O>, 'execute'> & {
  execute(input: I, call: ToolCallContext, ctx: ProductToolContext): Promise<O>;
};

export { ToolIdentitySchema as toolIdentitySchema };
export type { DbId };
